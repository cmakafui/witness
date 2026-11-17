// The records of the graph, and the Cypher that writes them. The hub runs these statements on its store (bun:ffi),
// and the web page runs the same statements on its copy (WASM), so the two graphs stay the same.
// Every statement is a MERGE by id: writing a record twice is the same as writing it once.
//
// A Goal states the solved condition and names at most one acceptance question. A Question is what was asked:
// its text, its rule, its probe and its inputs. A Run is
// one execution of the probe, written once, when it ends: what it measured, what it read and saved, and the answer
// the rule gave on its measurements. The answer of a question now is never stored: it is the answer of the run on the
// question's inputs as they are now.

export type Label = "Goal" | "Question" | "Run" | "File";
export type RelType = "ACCEPTED_BY" | "NEEDS" | "REPLACES" | "OF" | "READ" | "SAVED";

export type GNode = { label: Label; id: string; props: Record<string, string | number | boolean | string[] | null> };
export type GRel = { type: RelType; from: string; to: string; name?: string };

/** The label at each end of each relationship type. schema.cypher declares the same. */
export const ENDS: Record<RelType, [Label, Label]> = {
  ACCEPTED_BY: ["Goal", "Question"],
  NEEDS: ["Question", "Question"],
  REPLACES: ["Question", "Question"],
  OF: ["Run", "Question"],
  READ: ["Run", "File"],
  SAVED: ["Run", "File"],
};

/**
 * Every record is found by its id. These make the index for it: without one, a store scans a whole label for each
 * record it writes. schema.cypher declares the same for the hub's store; the page's copies use these.
 */
export const UNIQUE_IDS = Object.keys({ Goal: 0, Question: 0, Run: 0, File: 0 } satisfies Record<Label, 0>).map(
  (label) => `CREATE CONSTRAINT ${label.toLowerCase()}_id FOR (n:${label}) REQUIRE n.id IS UNIQUE`,
);

/** The queries that read a whole graph as records, for a page that connects or a copy of the page's graph. */
export const ALL_NODES = "MATCH (n) RETURN labels(n)[0] AS label, n.id AS id, properties(n) AS props";
export const ALL_RELS = "MATCH (a)-[r]->(b) RETURN type(r) AS type, a.id AS from, b.id AS to, r.name AS name";

export type Statement = { cypher: string; params: { rows: unknown[] } };

/** The statements that write these records: one per label, then one per relationship type. */
export function statements(nodes: GNode[], rels: GRel[]): Statement[] {
  const out: Statement[] = [];
  for (const label of new Set(nodes.map((n) => n.label)))
    out.push({
      cypher: `UNWIND $rows AS x MERGE (n:${label} {id: x.id}) ON CREATE SET n += x.props`,
      params: { rows: nodes.filter((n) => n.label === label).map((n) => ({ id: n.id, props: { ...n.props, id: n.id } })) },
    });
  for (const type of new Set(rels.map((r) => r.type))) {
    const [a, b] = ENDS[type];
    const named = type === "READ" || type === "SAVED";
    out.push({
      cypher: `UNWIND $rows AS x MATCH (a:${a} {id: x.from}), (b:${b} {id: x.to}) MERGE (a)-[:${type}${named ? " {name: x.name}" : ""}]->(b)`,
      params: { rows: rels.filter((r) => r.type === type).map(({ from, to, name }) => ({ from, to, name: name ?? null })) },
    });
  }
  return out;
}

/** The graph, as agents read it: in the MCP query tool and in the page's WebMCP query tool. */
export const SCHEMA = `The graph:
(:Goal {id, text, seq})-[:ACCEPTED_BY]->(:Question)  the goal's only acceptance question, bound before it runs
(:Question {id, text, rule, probe, inputs, asker, seq})
(:Question)-[:NEEDS]->(:Question)      reads a file the other question saved
(:Question)-[:REPLACES]->(:Question)   fixes a question whose run crashed or timed out; the old answer stays
(:Run {id, key, seq, started, ms, answer, reason, measured, results})-[:OF]->(:Question)
(:Run)-[:READ {name}]->(:File {id})    the inputs the run read; a File's id is its SHA-256
(:Run)-[:SAVED {name}]->(:File)               the files the run saved for other questions
rule is a Cypher expression over the run's measurements. answer is yes, no or failed: the rule's value on that run. results is the measurements as JSON. measured is true when the probe measured, even if the rule could not decide: then other questions can read the files it saved. started is when the run began, in milliseconds since 1970. ms is how long it took.
Answers now come as parameters: $yes, $no, $failed, $running, $pending and $waiting are lists of question ids. $current lists the runs that give the current answers. A Run's answer is the answer of that run, not always the answer now. key names the inputs a run read. A run that measured is final for its key. Runs that did not measure can share a key with the retry that followed them: the latest run on the current inputs gives the answer.
$replaced lists the questions that a newer question replaces and that still have no measured yes or no. Leave them out of open problems: WHERE NOT q.id IN $replaced.
$complete and $incomplete are goal ids. A goal is complete only when its acceptance question currently answers yes. No acceptance question means open and incomplete. All other acceptance states mean incomplete. No other question determines completion. Goals and acceptance bindings cannot be edited; changing the acceptance contract requires a new goal.`;

/** A question's answer as the hub works it out. It is never stored: it comes from the runs and the inputs now. */
export type State = "yes" | "no" | "failed" | "running" | "pending" | "waiting";

export type Status = {
  id: string;
  state: State;
  run: string | null; // the run that gives the answer, when there is one
  was: "yes" | "no" | null; // when pending or running: the answer on the inputs before
  reason: string | null; // why it failed, or what it waits for
};

export type RecordedRun = { id: string; answer: "yes" | "no" | "failed"; reason: string | null; measured: boolean; saved: string[] };

/** Answers from recorded runs alone. An unrun consumer waits until its producers measured and saved its inputs. */
export function recordedStatuses(questions: Iterable<{ id: string; inputs: string[] }>, latest: ReadonlyMap<string, RecordedRun>): Map<string, Status> {
  const states = new Map<string, Status>();
  for (const { id, inputs } of questions) {
    const run = latest.get(id);
    const status: Status = { id, state: run?.answer ?? "pending", run: run?.id ?? null, was: null, reason: run?.reason ?? null };
    states.set(id, status);
    if (run) continue;
    for (const name of inputs) {
      const ref = /^(q-[0-9a-f]{12})\/(.+)$/.exec(name);
      if (!ref) continue;
      const producer = latest.get(ref[1]!);
      if (!producer) status.reason = `${ref[1]} has no recorded run yet`;
      else if (!producer.measured) status.reason = `${ref[1]} did not measure, so its files cannot be read`;
      else if (!producer.saved.includes(ref[2]!)) status.reason = `${ref[1]} saved no file named ${ref[2]}`;
      else continue;
      status.state = "waiting";
      break;
    }
  }
  return states;
}

export type Goal = { id: string; text: string; acceptance: string | null };
export type GoalStatus = Goal & { state: State | "open"; complete: boolean; reason: string | null };

/** The same goal records feed derived completion in the hub and in the browser. */
export const GOALS = `MATCH (g:Goal) OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id AS id, g.text AS text, q.id AS acceptance ORDER BY g.seq`;

export function goalStatuses(goals: Goal[], statuses: Status[]): GoalStatus[] {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return goals.map((g) => {
    const status = g.acceptance ? byId.get(g.acceptance) : undefined;
    return { ...g, state: g.acceptance ? status?.state ?? "waiting" : "open", complete: status?.state === "yes", reason: status?.reason ?? null };
  });
}

/**
 * The questions that a newer question replaces, while they still have no yes or no. The hub binds REPLACES only to a
 * question whose run did not measure. If a later run on new inputs measures yes or no, that answer is evidence again.
 */
export function replacedIds(statuses: Status[], replaces: Iterable<{ from: string; to: string }>): string[] {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const out = new Set<string>();
  for (const { from, to } of replaces) {
    const s = byId.get(to);
    if (byId.has(from) && s && s.state !== "yes" && s.state !== "no") out.add(to);
  }
  return [...out];
}

/**
 * The parameters every query gets, so a query can use the answers: $yes, $no, $failed, $running, $pending and
 * $waiting are lists of question ids, and $current is the list of runs that give the current answers.
 * $complete and $incomplete are goal ids, derived only from acceptance questions. $replaced comes from REPLACES.
 */
export function answerParams(
  statuses: Status[],
  goals: Goal[] = [],
  replaces: Iterable<{ from: string; to: string }> = [],
): Record<State | "current" | "complete" | "incomplete" | "replaced", string[]> {
  const ids = (s: State) => statuses.filter((x) => x.state === s).map((x) => x.id);
  const completion = goalStatuses(goals, statuses);
  return {
    yes: ids("yes"),
    no: ids("no"),
    failed: ids("failed"),
    running: ids("running"),
    pending: ids("pending"),
    waiting: ids("waiting"),
    current: statuses.flatMap((x) => (x.run && (x.state === "yes" || x.state === "no" || x.state === "failed") ? [x.run] : [])),
    complete: completion.filter((g) => g.complete).map((g) => g.id),
    incomplete: completion.filter((g) => !g.complete).map((g) => g.id),
    replaced: replacedIds(statuses, replaces),
  };
}

/**
 * Why a rule cannot be a rule, or null when it can. The engine checks its syntax. A rule only computes a value from
 * the measurements: it is evaluated on an empty store that refuses writes, so it has nothing to read or change.
 */
export function ruleProblem(rule: string): string | null {
  if (!rule.trim()) return "The question has no rule. Write it before anything runs: a Cypher expression over the measurements, such as $p < 0.01 AND $gain >= 0.1.";
  if (!/\$[A-Za-z_]\w*/.test(rule)) return "The rule names no measurement. Name each one with $: $total > 10 is yes when the run printed a total above 10.";
  return null;
}

/** The statement that evaluates a rule. Each measurement is a parameter: $name, and $results for all of them. */
export const ruleStatement = (rule: string) => `RETURN (${rule}) AS answer`;

/**
 * A rule's parts at its top-level ANDs, so the page can show which part held. A rule with a top-level OR or XOR is
 * one part: its parts alone do not say why it holds.
 */
export function clauses(rule: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < rule.length; i++) {
    const c = rule[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && /\w/.test(c) && !/\w/.test(rule[i - 1] ?? "")) {
      const word = /^\w+/.exec(rule.slice(i))![0].toUpperCase();
      if (word === "OR" || word === "XOR") return [rule.trim()];
      if (word === "AND") {
        parts.push(rule.slice(start, i).trim());
        start = i + 3;
      }
      i += word.length - 1;
    }
  }
  parts.push(rule.slice(start).trim());
  return parts.filter(Boolean);
}

/** The measurements a rule names, in order, without repeats. */
export const named = (rule: string) => [...new Set([...rule.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!))];

/** The measurements of a run as parameters: each name gets its last value, and $results gets every measurement. */
export function measurements(results: Record<string, unknown>[]): Record<string, unknown> {
  return { ...Object.assign({}, ...results), results };
}
