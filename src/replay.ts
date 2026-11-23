// witness replay: loads a recorded store read-only for manual inspection and read-only MCP. No agent, hub or uv.
import { existsSync } from "node:fs";
import { join } from "node:path";
import page from "../page/index.html";
import { answerParams, GOALS, type Goal, recordedStatuses, type RecordedRun, type Status } from "./graph.ts";
import { findFile, Refusal, snapshot } from "./hub.ts";
import { readOnlyMcp, type ReadOnlyStore } from "./mcp.ts";
import { type Param, Relate } from "./relate.ts";
import { fileResponse, sameOrigin } from "./server.ts";

export function replay(root: string, { port = 4748, hostname = "127.0.0.1" } = {}) {
  const graphDir = join(root, ".witness", "graph");
  if (!existsSync(graphDir)) throw new Error(`There is no Witness store in ${root}/.witness.`);
  const db = Relate.open(graphDir, { readOnly: true });
  let graph: ReturnType<typeof snapshot>;
  let states: Status[];
  let goals: Goal[];
  let replaces: { from: string; to: string }[];
  const savedBy = new Map<string, { name: string; file: string }[]>();
  try {
    graph = snapshot(db);
    goals = db.query(GOALS) as Goal[];
    replaces = graph.rels.filter((r) => r.type === "REPLACES").map((r) => ({ from: r.from, to: r.to }));
    for (const r of graph.rels) {
      if (r.type === "SAVED" && r.name) (savedBy.get(r.from)?.push({ name: r.name, file: r.to }) ?? savedBy.set(r.from, [{ name: r.name, file: r.to }]));
    }
    const latest = new Map<string, RecordedRun>();
    for (const r of db.query(`MATCH (r:Run)-[:OF]->(q:Question) OPTIONAL MATCH (r)-[s:SAVED]->(:File)
      RETURN q.id AS question, r.id AS run, r.answer AS answer, r.reason AS reason, r.measured AS measured, collect(s.name) AS saved, r.seq AS seq ORDER BY seq`))
      latest.set(String(r.question), { id: String(r.run), answer: r.answer as RecordedRun["answer"], reason: r.reason as string | null, measured: r.measured === true, saved: r.saved as string[] });
    states = [...recordedStatuses(graph.nodes.filter((n) => n.label === "Question").map((q) => ({ id: q.id, inputs: q.props.inputs as string[] })), latest).values()];
  } finally {
    db.close();
  }
  const files = join(root, ".witness", "files");
  const byId = new Map(states.map((s) => [s.id, s]));
  const params = answerParams(states, goals, replaces);
  const store: ReadOnlyStore = {
    query(cypher: string, extra: Record<string, Param> = {}, limit = 200) {
      const reader = Relate.open(graphDir, { readOnly: true });
      try {
        const rows = reader.query(cypher, { ...params, ...extra });
        return { rows: rows.slice(0, limit), truncated: rows.length > limit };
      } finally {
        reader.close();
      }
    },
    look(ref: string) {
      const runOf = (q: string) => {
        if (!byId.has(q)) throw new Refusal(`There is no question ${q}. Call query to list the questions.`);
        return byId.get(q)!.run;
      };
      return findFile(ref, files, runOf, (run) => savedBy.get(run) ?? []);
    },
  };
  const handle = readOnlyMcp(store);
  return Bun.serve({
    port,
    hostname,
    routes: {
      "/": page,
      "/mcp": (req, srv): Promise<Response> | Response =>
        sameOrigin(req, srv.url) ? handle(req) : new Response("Forbidden: this request did not come from this machine's replay address.", { status: 403 }),
      "/files/:id": (req) => fileResponse(req, files),
      "/events": (req, srv) => (srv.upgrade(req) ? undefined : new Response("Expected a WebSocket", { status: 400 })),
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "graph", ...graph }));
        ws.send(JSON.stringify({ type: "states", states }));
      },
      message() {},
    },
  });
}
