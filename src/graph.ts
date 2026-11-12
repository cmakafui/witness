// The records of the graph, and the Cypher that writes them. The hub runs these statements on its store (bun:ffi),
// and the web page runs the same statements on its copy (WASM), so the two graphs stay the same.
// Every statement is a MERGE by id: writing a record twice is the same as writing it once.

export type Label = "Question" | "Run" | "Answer" | "File" | "Package";
export type RelType = "PROBE" | "NEEDS" | "DISPUTES" | "ANSWERS" | "READ" | "SAVED" | "USED" | "OF" | "LOG";

export type GNode = { label: Label; id: string; props: Record<string, string | number | string[] | null> };
export type GRel = { type: RelType; from: string; to: string; role?: string; name?: string };

/** The label at each end of each relationship type. schema.cypher declares the same. */
export const ENDS: Record<RelType, [Label, Label]> = {
  PROBE: ["Question", "File"],
  NEEDS: ["Question", "Question"],
  DISPUTES: ["Question", "Question"],
  ANSWERS: ["Run", "Question"],
  READ: ["Run", "File"],
  SAVED: ["Run", "File"],
  USED: ["Run", "Package"],
  OF: ["Answer", "Run"],
  LOG: ["Answer", "File"],
};

/** The properties that make a relationship different from another of the same type between the same nodes. */
const KEY: Partial<Record<RelType, string>> = { READ: " {role: x.role, name: x.name}", SAVED: " {name: x.name}" };

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
    out.push({
      cypher: `UNWIND $rows AS x MATCH (a:${a} {id: x.from}), (b:${b} {id: x.to}) MERGE (a)-[:${type}${KEY[type] ?? ""}]->(b)`,
      params: { rows: rels.filter((r) => r.type === type).map(({ from, to, role, name }) => ({ from, to, role: role ?? null, name: name ?? null })) },
    });
  }
  return out;
}

/** A question's answer as the hub works it out. It is never stored: it comes from the runs and the inputs now. */
export type State = "yes" | "no" | "failed" | "running" | "pending" | "waiting";

export type Status = {
  id: string;
  state: State;
  run: string | null; // the run that gives the answer, when there is one
  was: "yes" | "no" | null; // when pending: the answer on the inputs before
  reason: string | null; // why it failed, or what it waits for
};

/**
 * The parameters every query gets, so a query can use the answers: $yes, $no, $failed, $running, $pending and
 * $waiting are lists of question ids, and $current is the list of runs that give the current answers.
 */
export function answerParams(statuses: Status[]): Record<string, string[]> {
  const ids = (s: State) => statuses.filter((x) => x.state === s).map((x) => x.id);
  return {
    yes: ids("yes"),
    no: ids("no"),
    failed: ids("failed"),
    running: ids("running"),
    pending: ids("pending"),
    waiting: ids("waiting"),
    current: statuses.flatMap((x) => (x.run && (x.state === "yes" || x.state === "no" || x.state === "failed") ? [x.run] : [])),
  };
}
