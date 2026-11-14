// witness replay: loads a recorded store read-only. The page's tour controls playback. No agent, hub or uv.
import { existsSync } from "node:fs";
import { join } from "node:path";
import page from "../page/index.html";
import type { Status } from "./graph.ts";
import { snapshot } from "./hub.ts";
import { Relate } from "./relate.ts";

export function replay(root: string, { port = 4748, hostname = "127.0.0.1" } = {}) {
  if (!existsSync(join(root, ".witness", "graph"))) throw new Error(`There is no Witness store in ${root}/.witness.`);
  const db = Relate.open(join(root, ".witness", "graph"), { readOnly: true });
  let graph: ReturnType<typeof snapshot>;
  let states: Status[];
  try {
    graph = snapshot(db);
    const latest = new Map<string, Status>();
    for (const r of db.query("MATCH (r:Run)-[:OF]->(q:Question) RETURN q.id AS question, r.id AS run, r.answer AS answer, r.reason AS reason ORDER BY r.seq"))
      latest.set(String(r.question), { id: String(r.question), state: r.answer as Status["state"], run: String(r.run), was: null, reason: r.reason as string | null });
    states = graph.nodes.filter((n) => n.label === "Question").map((q) =>
      latest.get(q.id) ?? { id: q.id, state: "pending", run: null, was: null, reason: null });
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
