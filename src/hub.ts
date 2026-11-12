// The hub: the only process that writes the graph. It records questions and runs, works out each answer from the
// runs and the inputs as they are now, and runs again every question whose inputs changed.
//
// An answer is never stored. For each question the hub resolves its inputs now (a workspace file by its hash; an
// output of another question by the file that question's current run saved), and hashes them with the probe into a
// key. The answer is the answer of the run on that key. No run on that key: the question is pending, and it runs.
// A question that failed on a key never runs again on that key.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { answerParams, type GNode, type GRel, type State, type Status, statements } from "./graph.ts";
import { isFile, runProbe, type ProbeOutcome } from "./probe.ts";
import { type Param, Relate, type Row } from "./relate.ts";
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
  disputes?: string[];
  asker?: string;
  timeoutS?: number;
  waitS?: number;
};

export type Event =
  | { type: "graph"; nodes: GNode[]; rels: GRel[] }
  | { type: "states"; states: Status[] }
  | { type: "result"; question: string; run: string; data: unknown };

type Question = { id: string; text: string; rule: string; inputs: string[]; timeout: number; seq: number; probe: string };
type Run = { id: string; question: string; key: string; seq: number; answer: "yes" | "no" | "failed" | null; reason: string | null };
type Input = { name: string; file: string; path: string };
type Resolved = { status: Status; question: Question; key: string | null; inputs: Input[] };

export class Hub {
  private running = new Map<string, string>(); // question -> its run in progress
  private hashes = new Map<string, { stamp: string; sha: string }>();
  private listeners = new Set<(e: Event) => void>();
  private wakers = new Set<() => void>();
  private timer: Timer | undefined;
  private shown = "";

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
    mkdirSync(filesDir, { recursive: true });
    const fresh = !existsSync(graphDir);
    const db = Relate.open(graphDir);
    if (fresh) await applySchema(db);
    const [row] = db.query("MATCH (n) WHERE n.seq IS NOT NULL RETURN max(n.seq) AS seq");
    const hub = new Hub(root, db, graphDir, filesDir, Number(row?.seq ?? 0), jobs);
    if (pollMs > 0) {
      hub.timer = setInterval(() => hub.check(), pollMs);
      hub.timer.unref();
    }
    return hub;
  }

  close() {
    clearInterval(this.timer);
    this.db.close();
  }

  /** Calls fn with every change: new records, new states, and results as probes print them. */
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
    this.emit({ type: "graph", nodes, rels });
  }

  /** Keeps a file's content in .witness/files, named by its hash, and returns its File record. */
  private keep(content: Uint8Array): GNode {
    const id = sha256(content);
    const path = join(this.filesDir, id);
    if (!existsSync(path)) writeFileSync(path, content);
    return { label: "File", id, props: { bytes: content.byteLength } };
  }

  private questions(): Question[] {
    return this.db.query(
      `MATCH (q:Question)-[:PROBE]->(f:File)
       RETURN q.id AS id, q.text AS text, q.rule AS rule, q.inputs AS inputs, q.timeout AS timeout, q.seq AS seq, f.id AS probe
       ORDER BY q.seq`,
    ) as Question[];
  }

  private runs(): Run[] {
    return this.db.query(
      `MATCH (r:Run)-[:ANSWERS]->(q:Question) OPTIONAL MATCH (a:Answer)-[:OF]->(r)
       RETURN r.id AS id, q.id AS question, r.key AS key, r.seq AS seq, a.value AS answer, a.reason AS reason
       ORDER BY r.seq`,
    ) as Run[];
  }

  private saved(run: string): { name: string; file: string }[] {
    return this.db.query("MATCH (:Run {id: $run})-[s:SAVED]->(f:File) RETURN s.name AS name, f.id AS file", { run }) as never;
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
    const questions = this.questions();
    const byId = new Map(questions.map((q) => [q.id, q]));
    const runs = Map.groupBy(this.runs(), (r) => r.question);
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
          if (!upr || (upr.status.state !== "yes" && upr.status.state !== "no"))
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
      const running = this.running.get(q.id);
      const before = mine.findLast((r) => r.answer === "yes" || r.answer === "no")?.answer as "yes" | "no" | undefined;
      if (running) return done({ question: q, key, inputs, status: status("running", { run: running, was: before ?? null }) });
      const onKey = mine.findLast((r) => r.key === key && r.answer !== null);
      if (onKey) return done({ question: q, key, inputs, status: status(onKey.answer!, { run: onKey.id, reason: onKey.reason }) });
      return done({ question: q, key, inputs, status: status("pending", { was: before ?? null }) });
    };
    return questions.map(compute);
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
    for (const r of all) {
      if (this.running.size >= this.jobs) break;
      if (r.status.state === "pending" && r.key) this.start(r);
    }
    const statuses = this.running.size ? this.statuses() : all.map((r) => r.status);
    const shown = JSON.stringify(statuses);
    if (shown !== this.shown) {
      this.shown = shown;
      this.emit({ type: "states", states: statuses });
    }
    return statuses;
  }

  private start({ question: q, key, inputs }: Resolved) {
    const seq = ++this.seq;
    const run = contentId("r", q.id, key!, String(seq));
    const files = inputs.filter((i) => !OUTPUT_REF.test(i.name)).map((i) => this.keep(readFileSync(i.path)));
    this.write(
      [{ label: "Run", id: run, props: { key: key!, seq } }, ...files],
      [
        { type: "ANSWERS", from: run, to: q.id },
        { type: "READ", from: run, to: q.probe, role: "probe", name: "probe.py" },
        ...inputs.map((i) => ({ type: "READ" as const, from: run, to: i.file, role: "input", name: i.name })),
      ],
    );
    this.running.set(q.id, run);
    const probe = readFileSync(join(this.filesDir, q.probe), "utf8");
    runProbe({
      probe,
      inputs: inputs.map((i) => ({ name: i.name, path: i.path })),
      timeoutS: q.timeout,
      onResult: (data) => this.emit({ type: "result", question: q.id, run, data }),
    })
      .catch((e): ProbeOutcome => ({
        answer: "failed",
        reason: `the hub could not run the probe: ${(e as Error).message}`,
        results: [],
        outputs: [],
        lock: null,
        packages: [],
        log: String((e as Error).stack ?? e),
        cleanup: () => {},
      }))
      .then((outcome) => this.finish(run, outcome))
      .catch((e) => console.error(`witness: could not record run ${run} of ${q.id}:`, e))
      .finally(() => {
        this.running.delete(q.id);
        const wake = [...this.wakers];
        this.wakers.clear();
        for (const w of wake) w();
        this.check();
      });
  }

  private finish(run: string, o: ProbeOutcome) {
    try {
      const seq = ++this.seq;
      const answer = `a-${run.slice(2)}`;
      const outputs = o.outputs.map((f) => ({ name: f.name, node: this.keep(readFileSync(f.path)) }));
      const lock = o.lock === null ? null : this.keep(Buffer.from(o.lock));
      const log = this.keep(Buffer.from(o.log));
      const packages: GNode[] = o.packages.map((p) => ({ label: "Package", id: `${p.name}@${p.version}`, props: { name: p.name, version: p.version } }));
      this.write(
        [
          { label: "Answer", id: answer, props: { value: o.answer, reason: o.reason, results: JSON.stringify(o.results), seq } },
          log,
          ...(lock ? [lock] : []),
          ...outputs.map((x) => x.node),
          ...packages,
        ],
        [
          { type: "OF", from: answer, to: run },
          { type: "LOG", from: answer, to: log.id },
          ...(lock ? [{ type: "READ" as const, from: run, to: lock.id, role: "lock", name: "probe.py.lock" }] : []),
          ...outputs.map((x) => ({ type: "SAVED" as const, from: run, to: x.node.id, name: x.name })),
          ...packages.map((p) => ({ type: "USED" as const, from: run, to: p.id })),
        ],
      );
    } finally {
      o.cleanup();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The three tools

  /** Asks a question and waits for its answer, up to waitS seconds. Asking the same question twice is one question. */
  async ask(a: Ask): Promise<Status & { question: string; results: unknown[]; saved: string[] }> {
    const inputs = [...new Set(a.inputs ?? [])].sort();
    const disputes = [...new Set(a.disputes ?? [])].sort();
    this.refuse(a, inputs, disputes);
    const probe = this.keep(Buffer.from(a.probe));
    const id = contentId("q", a.text, a.rule, probe.id, JSON.stringify(inputs), JSON.stringify(disputes));
    if (!this.db.query("MATCH (q:Question {id: $id}) RETURN q.id AS id", { id }).length) {
      const needs = [...new Set(inputs.flatMap((i) => OUTPUT_REF.exec(i)?.[1] ?? []))];
      this.write(
        [
          {
            label: "Question",
            id,
            props: { text: a.text, rule: a.rule, inputs, timeout: a.timeoutS ?? 600, asker: a.asker ?? null, seq: ++this.seq },
          },
          probe,
        ],
        [
          { type: "PROBE", from: id, to: probe.id },
          ...needs.map((n) => ({ type: "NEEDS" as const, from: id, to: n })),
          ...disputes.map((d) => ({ type: "DISPUTES" as const, from: id, to: d })),
        ],
      );
    }
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
    const results = s.run ? JSON.parse(String(this.db.query("MATCH (a:Answer)-[:OF]->(:Run {id: $run}) RETURN a.results AS r", { run: s.run })[0]?.r ?? "[]")) : [];
    return { ...s, question: a.text, results, saved: s.run ? this.saved(s.run).map((x) => `${id}/${x.name}`) : [] };
  }

  /** Answered, or nothing is left that could change it. */
  private settled(s: Status) {
    if (s.state === "yes" || s.state === "no" || s.state === "failed") return true;
    return s.state === "waiting" && this.running.size === 0;
  }

  private refuse(a: Ask, inputs: string[], disputes: string[]) {
    if (!a.text.trim()) throw new Refusal("The question has no text. Write it as one yes/no sentence.");
    if (!a.rule.trim()) throw new Refusal("The question has no rule. Write the rule that decides yes or no before anything runs.");
    if (!a.probe.includes("# /// script"))
      throw new Refusal('The probe has no uv script header. Start it with a PEP 723 block: "# /// script", its dependencies, "# ///".');
    if (!a.probe.includes("WITNESS_ANSWER"))
      throw new Refusal('The probe never prints WITNESS_ANSWER. Print it once, at the end: print("WITNESS_ANSWER yes") or print("WITNESS_ANSWER no").');
    const known = new Set(this.questions().map((q) => q.id));
    for (const name of inputs) {
      const ref = OUTPUT_REF.exec(name);
      if (ref) {
        if (!known.has(ref[1]!)) throw new Refusal(`Input ${name} names question ${ref[1]}, which does not exist.`);
        continue;
      }
      const clean = normalize(name);
      if (isAbsolute(name) || clean.startsWith(`..${sep}`) || clean === ".." || clean.split(sep)[0] === ".witness")
        throw new Refusal(`Input ${name} is outside the workspace. Give a path relative to the workspace root.`);
      if (!isFile(join(this.root, clean))) throw new Refusal(`Input ${name} is not a file in the workspace. Declare files, not folders.`);
    }
    for (const d of disputes) if (!known.has(d)) throw new Refusal(`The question disputes ${d}, which does not exist.`);
  }

  /**
   * Runs a read-only Cypher query on a fresh snapshot of the graph. The answers come as parameters: $yes, $no,
   * $failed, $running, $pending, $waiting (question ids) and $current (the runs that give the current answers).
   */
  query(cypher: string, params: Record<string, Param> = {}, limit = 200): { rows: Row[]; truncated: boolean } {
    const reader = Relate.open(this.graphDir, { readOnly: true });
    try {
      const rows = reader.query(cypher, { ...answerParams(this.statuses()), ...params });
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
    const nodes = this.db.query("MATCH (n) RETURN labels(n)[0] AS label, n.id AS id, properties(n) AS props") as GNode[];
    const rels = this.db.query("MATCH (a)-[r]->(b) RETURN type(r) AS type, a.id AS from, b.id AS to, r.role AS role, r.name AS name") as GRel[];
    return { nodes, rels: rels.map(({ role, name, ...r }) => ({ ...r, ...(role ? { role } : {}), ...(name ? { name } : {}) })) };
  }

  /** Waits until no probe runs. For tests and a clean shutdown. */
  async idle() {
    while (this.running.size) await new Promise<void>((resolve) => this.wakers.add(resolve));
  }
}
