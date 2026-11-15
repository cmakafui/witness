// The hub: the only process that writes the graph. It records questions and runs, works out each answer from the
// runs and the inputs as they are now, and runs again every question whose inputs changed.
//
// An answer is never stored. For each question the hub resolves its inputs now (a workspace file by its hash; an
// output of another question by the file that question's current run saved), and hashes them with the probe into a
// key. The answer is the answer of the run on that key. No run on that key: the question is pending, and it runs.
// The latest finished run on a key gives its cached answer. An explicit rerun appends another run on that key.
//
// A probe only measures. When a run ends, Relate evaluates the question's rule, a Cypher expression, on the run's
// measurements: true is yes, false is no, and anything else is failed. Then the hub writes the run, once.
//
// The hub is the only writer, and a record never changes. So it keeps the questions, the runs and the files they
// saved in memory, and adds each new record as it writes it. Working out the answers reads no store.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { answerParams, clauses, type GNode, type GRel, type Goal, type GoalStatus, GOALS, goalStatuses, measurements, ruleProblem, ruleStatement, type State, type Status, statements } from "./graph.ts";
import { dependencyProblem, isFile, runProbe, type ProbeOutcome, RESULT } from "./probe.ts";
import { type Param, Relate, RelateError, type Row } from "./relate.ts";
import { applySchema } from "./schema.ts";

/** A request the hub refuses. The message says what is wrong and how to fix it. */
export class Refusal extends Error {}

const sha256 = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
const contentId = (prefix: string, ...parts: string[]) => `${prefix}-${sha256(parts.join("\0")).slice(0, 12)}`;
/** An input that is a file saved by another question's current run: q-…/name. */
const OUTPUT_REF = /^(q-[0-9a-f]{12})\/(.+)$/;

export type Ask = {
  text: string;
  rule: string;
  probe: string;
  inputs?: string[];
  accepts?: string;
  asker?: string;
  timeoutS?: number;
  waitS?: number;
  rerun?: boolean;
};

export type Event =
  | { type: "graph"; nodes: GNode[]; rels: GRel[] }
  | { type: "states"; states: Status[] };

type Question = { id: string; rule: string; probe: string; inputs: string[]; timeout: number };
type Run = { id: string; key: string; answer: "yes" | "no" | "failed"; reason: string | null; measured: boolean | null };
type Saved = { name: string; file: string };
type Input = { name: string; file: string; path: string };
type Resolved = { status: Status; question: Question; key: string | null; inputs: Input[] };

export class Hub {
  private byId = new Map<string, Question>(); // every question, in the order asked
  private runsOf = new Map<string, Run[]>(); // question -> its runs, in the order they ended
  private measured = new Set<string>(); // the runs whose probe measured
  private savedBy = new Map<string, Saved[]>(); // run -> the files it saved
  private running = new Map<string, string>(); // question -> its run in progress
  private reruns = new Set<string>(); // explicit requests awaiting inputs or a worker slot
  private hashes = new Map<string, { stamp: string; sha: string }>();
  private listeners = new Set<(e: Event) => void>();
  private wakers = new Set<() => void>();
  private timer: Timer | undefined;
  private shown = "";
  /** An empty store in memory, where rules are evaluated. A rule never sees the graph. */
  private judge = Relate.open(":memory:");

  private constructor(
    readonly root: string,
    private db: Relate,
    private graphDir: string,
    private filesDir: string,
    private seq: number,
    private jobs: number,
  ) {}

  /** Opens the workspace's store, in root/.witness, and creates it the first time. */
  static async open(root: string, { pollMs = 1000, jobs = 4 } = {}): Promise<Hub> {
    const dir = join(root, ".witness");
    const graphDir = join(dir, "graph");
    const filesDir = join(dir, "files");
    const fresh = !existsSync(graphDir);
    mkdirSync(filesDir, { recursive: true });
    const db = Relate.open(graphDir);
    if (fresh) await applySchema(db);
    const [row] = db.query("MATCH (n) WHERE n.seq IS NOT NULL RETURN max(n.seq) AS seq");
    const hub = new Hub(root, db, graphDir, filesDir, Number(row?.seq ?? 0), jobs);
    const { nodes, rels } = snapshot(db);
    hub.remember(nodes.sort((a, b) => Number(a.props.seq ?? 0) - Number(b.props.seq ?? 0)), rels);
    if (pollMs > 0) {
      hub.timer = setInterval(() => hub.check(), pollMs);
      hub.timer.unref();
    }
    return hub;
  }

  close() {
    clearInterval(this.timer);
    this.db.close();
    this.judge.close();
  }

  /** Calls fn with every change: new records and new states. */
  on(fn: (e: Event) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: Event) {
    for (const fn of this.listeners) fn(e);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Records

  private write(nodes: GNode[], rels: GRel[]) {
    this.db.transaction(() => {
      for (const s of statements(nodes, rels)) this.db.query(s.cypher, s.params as Record<string, Param>);
    });
    this.remember(nodes, rels);
    this.emit({ type: "graph", nodes, rels });
  }

  /** Adds written records to the hub's memory of the store. Records arrive in the order of their seq. */
  private remember(nodes: GNode[], rels: GRel[]) {
    const add = <T>(map: Map<string, T[]>, key: string, value: T) => void (map.get(key)?.push(value) ?? map.set(key, [value]));
    const of = new Map(rels.filter((r) => r.type === "OF").map((r) => [r.from, r.to]));
    for (const n of nodes) {
      const p = n.props;
      if (n.label === "Question" && !this.byId.has(n.id))
        this.byId.set(n.id, { id: n.id, rule: String(p.rule), probe: String(p.probe), inputs: p.inputs as string[], timeout: Number(p.timeout) });
      if (n.label === "Run") {
        const run: Run = { id: n.id, key: String(p.key), answer: p.answer as Run["answer"], reason: (p.reason as string | null) ?? null, measured: (p.measured as boolean | null) ?? null };
        add(this.runsOf, of.get(n.id)!, run);
        if (run.measured) this.measured.add(run.id);
      }
    }
    for (const r of rels)
      if (r.type === "SAVED") add(this.savedBy, r.from, { name: r.name!, file: r.to });
  }

  /** Keeps a file's content in .witness/files, named by its hash, and returns its File record. */
  private keep(content: Uint8Array): GNode {
    const id = sha256(content);
    const path = join(this.filesDir, id);
    if (!existsSync(path)) writeFileSync(path, content);
    return { label: "File", id, props: {} };
  }

  private saved(run: string): Saved[] {
    return this.savedBy.get(run) ?? [];
  }

  /** The hash of a workspace file now, or null when it is missing. Cached by size and time of change. */
  private hash(path: string): string | null {
    try {
      const st = statSync(path);
      if (!st.isFile()) return null;
      const stamp = `${st.size}:${st.mtimeMs}`;
      const known = this.hashes.get(path);
      if (known?.stamp === stamp) return known.sha;
      const sha = sha256(readFileSync(path));
      this.hashes.set(path, { stamp, sha });
      return sha;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Answers

  /** Every question with its answer now. */
  private resolve(): Resolved[] {
    // A run's files can be read when its probe measured, whatever its rule said. A crash may leave half a file.
    const { byId, runsOf: runs, measured } = this;
    const memo = new Map<string, Resolved>();

    const compute = (q: Question): Resolved => {
      const known = memo.get(q.id);
      if (known) return known;
      const status = (state: State, extra: Partial<Status> = {}): Status => ({ id: q.id, state, run: null, was: null, reason: null, ...extra });
      const done = (r: Resolved) => (memo.set(q.id, r), r);
      const inputs: Input[] = [];
      for (const name of q.inputs) {
        const ref = OUTPUT_REF.exec(name);
        if (ref) {
          const up = byId.get(ref[1]!);
          const upr = up ? compute(up) : null;
          const above = upr?.status;
          if (above?.state === "failed" && !measured.has(above.run!))
            return done({ question: q, key: null, inputs, status: status("waiting", { reason: `${ref[1]} failed, so its files cannot be read: ${above.reason}` }) });
          if (!upr || !above || (above.state !== "yes" && above.state !== "no" && above.state !== "failed"))
            return done({ question: q, key: null, inputs, status: status("waiting", { reason: `${ref[1]} has no answer yet` }) });
          const file = this.saved(upr.status.run!).find((s) => s.name === ref[2]);
          if (!file) return done({ question: q, key: null, inputs, status: status("waiting", { reason: `${ref[1]} saved no file named ${ref[2]}` }) });
          inputs.push({ name, file: file.file, path: join(this.filesDir, file.file) });
        } else {
          const path = join(this.root, name);
          const sha = this.hash(path);
          if (!sha) return done({ question: q, key: null, inputs, status: status("waiting", { reason: `${name} is not in the workspace` }) });
          inputs.push({ name, file: sha, path });
        }
      }
      const key = sha256(JSON.stringify([q.probe, inputs.map((i) => [i.name, i.file])]));
      const mine = runs.get(q.id) ?? [];
      const before = mine.findLast((r) => r.answer === "yes" || r.answer === "no")?.answer as "yes" | "no" | undefined;
      const running = this.running.get(q.id);
      if (running) return done({ question: q, key, inputs, status: status("running", { run: running, was: before ?? null }) });
      if (this.reruns.has(q.id)) return done({ question: q, key, inputs, status: status("pending", { was: before ?? null }) });
      const onKey = mine.findLast((r) => r.key === key);
      if (onKey) return done({ question: q, key, inputs, status: status(onKey.answer, { run: onKey.id, reason: onKey.reason }) });
      return done({ question: q, key, inputs, status: status("pending", { was: before ?? null }) });
    };
    return [...byId.values()].map(compute);
  }

  /** Every question's answer now. */
  statuses(): Status[] {
    return this.resolve().map((r) => r.status);
  }

  status(id: string): Status {
    const s = this.statuses().find((x) => x.id === id);
    if (!s) throw new Refusal(`There is no question ${id}. Call query to list the questions.`);
    return s;
  }

  /** Starts the pending questions, oldest first, while fewer than `jobs` run. Tells listeners when states change. */
  check(): Status[] {
    const all = this.resolve();
    let started = false;
    for (const r of all) {
      if (this.running.size >= this.jobs) break;
      if (r.status.state === "pending" && r.key) (this.start(r), (started = true));
    }
    const statuses = started ? this.statuses() : all.map((r) => r.status);
    const shown = JSON.stringify(statuses);
    if (shown !== this.shown) {
      this.shown = shown;
      this.emit({ type: "states", states: statuses });
    }
    return statuses;
  }

  private start({ question: q, key, inputs }: Resolved) {
    // Each execution is a new record, even when the question and input key are unchanged.
    const run = contentId("r", q.id, key!, crypto.randomUUID());
    // Keep the inputs as the run reads them: a file may change while the probe runs.
    const read = inputs.map((i) => ({ name: i.name, node: this.keep(readFileSync(i.path)) }));
    this.reruns.delete(q.id);
    this.running.set(q.id, run);
    runProbe({
      probe: q.probe,
      inputs: inputs.map((i) => ({ name: i.name, path: i.path })),
      timeoutS: q.timeout,
    })
      .catch((e): ProbeOutcome => ({
        failed: `the hub could not run the probe: ${(e as Error).message}`,
        started: Date.now(),
        ms: 0,
        results: [],
        outputs: [],
        cleanup: () => {},
      }))
      .then((outcome) => this.finish(q, run, key!, read, outcome))
      .catch((e) => console.error(`witness: could not record run ${run} of ${q.id}:`, e))
      .finally(() => {
        this.running.delete(q.id);
        const wake = [...this.wakers];
        this.wakers.clear();
        for (const w of wake) w();
        this.check();
      });
  }

  /** The rule's answer on a run's measurements. Only true is yes and only false is no. */
  private decide(rule: string, results: Record<string, unknown>[]): { answer: "yes" | "no" | "failed"; reason: string | null } {
    let rows: Row[];
    const params = measurements(results) as Record<string, Param>;
    try {
      rows = this.judge.query(ruleStatement(rule), params);
    } catch (e) {
      const message = (e as Error).message;
      const missing = /ParameterMissing: Expected parameter\(s\): (.+)$/.exec(message);
      if (missing) return { answer: "failed", reason: `the run did not measure ${missing[1]}, which the rule needs` };
      return { answer: "failed", reason: `the rule could not be evaluated on the measurements: ${message}` };
    }
    const value = rows[0]?.answer;
    if (value === true) return { answer: "yes", reason: null };
    if (value === false) return { answer: "no", reason: null };
    if (value === null || value === undefined) return { answer: "failed", reason: this.whyNull(rule, params) };
    return { answer: "failed", reason: `the rule's value is ${JSON.stringify(value)}, not true or false` };
  }

  /** Why a rule's value is null: the part that is null, and how to say what a missing value means. */
  private whyNull(rule: string, params: Record<string, Param>): string {
    const parts = clauses(rule);
    const isNull = (part: string) => {
      try {
        return (this.judge.query(ruleStatement(part), params)[0]?.answer ?? null) === null;
      } catch {
        return false;
      }
    };
    const part = parts.length > 1 ? parts.find(isNull) : undefined;
    const rows = /\b(any|all|none|single)\s*\(/i.test(part ?? rule);
    return (
      `the rule's value is null: a measurement it needs is null${part ? `, in ${part}` : ""}. ` +
      (rows ? "A row without a field gives null. " : "") +
      "Say in the rule what a missing value means, for example coalesce(r.x, 0) < 1 or r.x IS NOT NULL AND r.x < 1."
    );
  }

  private finish(q: Question, run: string, key: string, read: { name: string; node: GNode }[], o: ProbeOutcome) {
    try {
      const { answer, reason } = o.failed === null ? this.decide(q.rule, o.results) : { answer: "failed" as const, reason: o.failed };
      const outputs = o.outputs.map((f) => ({ name: f.name, node: this.keep(readFileSync(f.path)) }));
      this.write(
        [
          {
            label: "Run",
            id: run,
            props: {
              key,
              seq: ++this.seq,
              started: o.started,
              ms: o.ms,
              answer,
              reason,
              measured: o.failed === null,
              results: JSON.stringify(o.results),
            },
          },
          ...read.map((x) => x.node),
          ...outputs.map((x) => x.node),
        ],
        [
          { type: "OF", from: run, to: q.id },
          ...read.map((x) => ({ type: "READ" as const, from: run, to: x.node.id, name: x.name })),
          ...outputs.map((x) => ({ type: "SAVED" as const, from: run, to: x.node.id, name: x.name })),
        ],
      );
    } finally {
      o.cleanup();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The tools

  /** Creates a new immutable goal, even when another goal has the same text. */
  goal(text: string): GoalStatus {
    if (!text.trim()) throw new Refusal("The goal has no solved condition. State what a successful result must satisfy.");
    const id = contentId("g", crypto.randomUUID());
    this.write([{ label: "Goal", id, props: { text: text.trim(), seq: ++this.seq } }], []);
    return { id, text: text.trim(), acceptance: null, state: "open", complete: false, reason: null };
  }

  goals(): GoalStatus[] {
    return goalStatuses(this.db.query(GOALS) as Goal[], this.statuses());
  }

  /** Reuses the question and its latest cached answer, or explicitly requests another execution. */
  async ask(a: Ask): Promise<Status & { question: string; results: unknown[]; saved: string[]; goal: GoalStatus | null }> {
    const inputs = [...new Set(a.inputs ?? [])].sort();
    this.refuse(a, inputs);
    const id = contentId("q", a.text, a.rule, sha256(a.probe), JSON.stringify(inputs), a.accepts ?? "");
    const goal = a.accepts;
    if (goal !== undefined) {
      const g = (this.db.query(GOALS) as Goal[]).find((g) => g.id === goal);
      if (!g) throw new Refusal(`There is no goal ${goal}. Call goal first, or query existing goals.`);
      if (g.acceptance && g.acceptance !== id)
        throw new Refusal(`${goal} already has acceptance question ${g.acceptance}. Its contract cannot change. Create a new goal.`);
    }
    if (!this.byId.has(id)) {
      const needs = [...new Set(inputs.flatMap((i) => OUTPUT_REF.exec(i)?.[1] ?? []))];
      this.write(
        [
          {
            label: "Question",
            id,
            props: { text: a.text, rule: a.rule, probe: a.probe, inputs, timeout: a.timeoutS ?? 600, asker: a.asker ?? null, seq: ++this.seq },
          },
        ],
        [
          ...needs.map((n) => ({ type: "NEEDS" as const, from: id, to: n })),
          ...(a.accepts ? [{ type: "ACCEPTED_BY" as const, from: a.accepts, to: id }] : []),
        ],
      );
    }
    // Concurrent requests join the execution already in progress; queued requests coalesce in the set.
    if (a.rerun && !this.running.has(id)) this.reruns.add(id);
    this.check();
    const deadline = Date.now() + (a.waitS ?? 120) * 1000;
    let s = this.status(id);
    while (!this.settled(s) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        this.wakers.add(resolve);
        setTimeout(resolve, Math.max(0, deadline - Date.now()));
      });
      s = this.status(id);
    }
    const done = s.state === "yes" || s.state === "no" || s.state === "failed";
    const results = done ? JSON.parse(String(this.db.query("MATCH (r:Run {id: $run}) RETURN r.results AS r", { run: s.run! })[0]?.r ?? "[]")) : [];
    return { ...s, question: a.text, results, saved: done ? this.saved(s.run!).map((x) => `${id}/${x.name}`) : [], goal: goal ? this.goals().find((g) => g.id === goal)! : null };
  }

  /** Answered, or nothing is left that could change it. */
  private settled(s: Status) {
    if (s.state === "yes" || s.state === "no" || s.state === "failed") return true;
    return s.state === "waiting" && this.running.size === 0;
  }

  private refuse(a: Ask, inputs: string[]) {
    if (!a.text.trim()) throw new Refusal("The question has no text. Write it as one yes/no sentence.");
    const problem = ruleProblem(a.rule);
    if (problem) throw new Refusal(problem);
    try {
      this.judge.query(`EXPLAIN ${ruleStatement(a.rule)}`);
    } catch (e) {
      if (e instanceof RelateError) throw new Refusal(`The rule is not a Cypher expression: ${e.message}`);
      throw e;
    }
    if (!a.probe.includes("# /// script"))
      throw new Refusal('The probe has no uv script header. Start it with a PEP 723 block: "# /// script", its dependencies, "# ///".');
    const deps = dependencyProblem(a.probe);
    if (deps) throw new Refusal(deps);
    if (!a.probe.includes(RESULT))
      throw new Refusal(`The probe never prints ${RESULT}. Print each measurement as a JSON object: print("${RESULT}", json.dumps({"total": total})).`);
    for (const name of inputs) {
      const ref = OUTPUT_REF.exec(name);
      if (ref) {
        if (!this.byId.has(ref[1]!)) throw new Refusal(`Input ${name} names question ${ref[1]}, which does not exist.`);
        continue;
      }
      const clean = normalize(name);
      if (isAbsolute(name) || clean.startsWith(`..${sep}`) || clean === ".." || clean.split(sep)[0] === ".witness")
        throw new Refusal(`Input ${name} is outside the workspace. Give a path relative to the workspace root.`);
      if (!isFile(join(this.root, clean))) throw new Refusal(`Input ${name} is not a file in the workspace. Declare files, not folders.`);
    }
  }

  /**
   * Runs a read-only Cypher query on a fresh snapshot of the graph. The answers come as parameters: $yes, $no,
   * $failed, $running, $pending and $waiting (question ids) and $current (the runs that give the answers).
   */
  query(cypher: string, params: Record<string, Param> = {}, limit = 200): { rows: Row[]; truncated: boolean } {
    const reader = Relate.open(this.graphDir, { readOnly: true });
    try {
      const rows = reader.query(cypher, { ...answerParams(this.statuses(), this.db.query(GOALS) as Goal[]), ...params });
      return { rows: rows.slice(0, limit), truncated: rows.length > limit };
    } finally {
      reader.close();
    }
  }

  /** Finds a kept file: by its hash, by q-…/name (the question's current run), or by r-…/name. */
  look(ref: string): { name: string; path: string; type: string; bytes: number } {
    let file: string | undefined;
    let name = ref;
    if (/^[0-9a-f]{64}$/.test(ref)) file = ref;
    else {
      const m = /^([qr]-[0-9a-f]{12})\/(.+)$/.exec(ref);
      if (!m) throw new Refusal(`${ref} is not a file. Give q-…/name, r-…/name, or a file's SHA-256.`);
      const run = m[1]!.startsWith("q-") ? this.status(m[1]!).run : m[1]!;
      if (!run) throw new Refusal(`${m[1]} has no run yet, so it saved no files.`);
      name = m[2]!;
      file = this.saved(run).find((s) => s.name === name)?.file;
      if (!file) throw new Refusal(`${run} saved no file named ${name}.`);
    }
    const path = join(this.filesDir, file);
    if (!existsSync(path)) throw new Refusal(`The hub keeps no file ${file}.`);
    return { name, path, type: Bun.file(name).type, bytes: statSync(path).size };
  }

  /** Where the hub keeps a file, by its SHA-256. Null for anything that is not a file id. */
  filePath(id: string): string | null {
    return /^[0-9a-f]{64}$/.test(id) ? join(this.filesDir, id) : null;
  }

  /** The whole graph as records, for a page that connects. */
  snapshot(): { nodes: GNode[]; rels: GRel[] } {
    return snapshot(this.db);
  }

  /** Whether a probe runs now. */
  busy(): boolean {
    return this.running.size > 0;
  }

  /** Waits until no probe runs. For tests and a clean shutdown. */
  async idle() {
    while (this.running.size) await new Promise<void>((resolve) => this.wakers.add(resolve));
  }
}

/** A store's whole graph as records. The hub sends it to a page; replay reads a recorded store with it. */
export function snapshot(db: Relate): { nodes: GNode[]; rels: GRel[] } {
  const nodes = db.query("MATCH (n) RETURN labels(n)[0] AS label, n.id AS id, properties(n) AS props") as GNode[];
  const rels = db.query("MATCH (a)-[r]->(b) RETURN type(r) AS type, a.id AS from, b.id AS to, r.name AS name") as GRel[];
  return { nodes, rels: rels.map(({ name, ...r }) => ({ ...r, ...(name ? { name } : {}) })) };
}
