// witness replay: loads a recorded store read-only for manual inspection. No agent, hub or uv.
import { existsSync } from "node:fs";
import { join } from "node:path";
import page from "../page/index.html";
import { recordedStatuses, type RecordedRun, type Status } from "./graph.ts";
import { snapshot } from "./hub.ts";
import { Relate } from "./relate.ts";

export function replay(root: string, { port = 4748, hostname = "127.0.0.1" } = {}) {
  if (!existsSync(join(root, ".witness", "graph"))) throw new Error(`There is no Witness store in ${root}/.witness.`);
  const db = Relate.open(join(root, ".witness", "graph"), { readOnly: true });
  let graph: ReturnType<typeof snapshot>;
  let states: Status[];
  try {
    graph = snapshot(db);
    const latest = new Map<string, RecordedRun>();
    for (const r of db.query(`MATCH (r:Run)-[:OF]->(q:Question) OPTIONAL MATCH (r)-[s:SAVED]->(:File)
      RETURN q.id AS question, r.id AS run, r.answer AS answer, r.reason AS reason, r.measured AS measured, collect(s.name) AS saved, r.seq AS seq ORDER BY seq`))
      latest.set(String(r.question), { id: String(r.run), answer: r.answer as RecordedRun["answer"], reason: r.reason as string | null, measured: r.measured === true, saved: r.saved as string[] });
    states = [...recordedStatuses(graph.nodes.filter((n) => n.label === "Question").map((q) => ({ id: q.id, inputs: q.props.inputs as string[] })), latest).values()];
  } finally {
    db.close();
  }
  const files = join(root, ".witness", "files");
  return Bun.serve({
    port,
    hostname,
    routes: {
      "/": page,
      "/files/:id": (req) => {
        const id = req.params.id;
        const path = join(files, id);
        if (!/^[0-9a-f]{64}$/.test(id) || !existsSync(path)) return new Response("Not found", { status: 404 });
        const name = new URL(req.url).searchParams.get("name") ?? id;
        return new Response(Bun.file(path), { headers: { "Content-Type": Bun.file(name).type, "X-Content-Type-Options": "nosniff" } });
      },
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
