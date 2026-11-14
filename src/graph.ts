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
export type RelType = "ACCEPTED_BY" | "FOR" | "NEEDS" | "OF" | "READ" | "SAVED";

export type GNode = { label: Label; id: string; props: Record<string, string | number | boolean | string[] | null> };
export type GRel = { type: RelType; from: string; to: string; name?: string };

/** The label at each end of each relationship type. schema.cypher declares the same. */
export const ENDS: Record<RelType, [Label, Label]> = {
  ACCEPTED_BY: ["Goal", "Question"],
  FOR: ["Question", "Goal"],
  NEEDS: ["Question", "Question"],
  OF: ["Run", "Question"],
  READ: ["Run", "File"],
  SAVED: ["Run", "File"],
};

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
(:Question)-[:FOR]->(:Goal)           exploratory purpose; one question may serve several goals; never votes on completion
(:Question {id, text, rule, probe, inputs, asker, seq})
(:Question)-[:NEEDS]->(:Question)      reads a file the other question saved
(:Run {id, key, seq, started, ms, answer, reason, measured, results})-[:OF]->(:Question)
(:Run)-[:READ {name}]->(:File {id, bytes})    the inputs the run read; a File's id is its SHA-256
(:Run)-[:SAVED {name}]->(:File)               the files the run saved for other questions
rule is a Cypher expression over the run's measurements. answer is yes, no or failed: the rule's value on that run. results is the measurements as JSON. measured is true when the probe measured, even if the rule could not decide: then other questions can read the files it saved. started is when the run began, in milliseconds since 1970. ms is how long it took.
Answers now come as parameters: $yes, $no, $failed, $running, $pending and $waiting are lists of question ids. $current lists the runs that give the current answers. A Run's answer is the answer of that run, not always the answer now.
$complete and $incomplete are goal ids. A goal is complete only when its acceptance question currently answers yes. No acceptance question means open and incomplete. All other acceptance states mean incomplete. Exploratory questions never determine completion. Goals and acceptance bindings cannot be edited; changing the acceptance contract requires a new goal.`;

/** A question's answer as the hub works it out. It is never stored: it comes from the runs and the inputs now. */
export type State = "yes" | "no" | "failed" | "running" | "pending" | "waiting";

export type Status = {
  id: string;
  state: State;
  run: string | null; // the run that gives the answer, when there is one
  was: "yes" | "no" | null; // when pending or running: the answer on the inputs before
  reason: string | null; // why it failed, or what it waits for
};

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
 * The parameters every query gets, so a query can use the answers: $yes, $no, $failed, $running, $pending and
 * $waiting are lists of question ids, and $current is the list of runs that give the current answers.
 * $complete and $incomplete are goal ids, derived only from acceptance questions.
 */
export function answerParams(statuses: Status[], goals: Goal[] = []): Record<State | "current" | "complete" | "incomplete", string[]> {
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
  };
}

/** Words that make a rule more than an expression. A rule only computes a value from the measurements. */
const NOT_IN_A_RULE = /\b(MATCH|CREATE|MERGE|SET|DELETE|DETACH|REMOVE|CALL|LOAD|UNION|FOREACH|USE|WITH|RETURN|UNWIND)\b/i;

/** Why a rule cannot be a rule, or null when it can. The engine checks its syntax. */
export function ruleProblem(rule: string): string | null {
  if (!rule.trim()) return "The question has no rule. Write it before anything runs: a Cypher expression over the measurements, such as $p < 0.01 AND $gain >= 0.1.";
  if (rule.includes(";")) return "A rule is one expression, without ;.";
  const word = NOT_IN_A_RULE.exec(rule.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/\$\w+/g, "$m"));
  if (word) return `A rule is one expression over the measurements, and ${word[1]} is not part of one. Write it like $p < 0.01 AND $gain >= 0.1.`;
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
