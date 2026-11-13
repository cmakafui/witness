// witness replay: plays a recorded session back to the page, from a store opened read-only. No agent, hub or uv.
//
// Records come in the order the hub wrote them (seq): a question when it was asked, a run when it ended. A question
// is pending until its first run, then shows the answer of its latest run so far. Each viewer gets its own playback.
import { existsSync } from "node:fs";
import { join } from "node:path";
import page from "../page/index.html";
import type { GNode, GRel, Status } from "./graph.ts";
import { snapshot } from "./hub.ts";
import { Relate } from "./relate.ts";

type Step = { at: number; nodes: GNode[]; rels: GRel[]; states: Status[] };

/** The session as steps, one per seq that wrote something. */
export function timeline(root: string): Step[] {
  const db = Relate.open(join(root, ".witness", "graph"), { readOnly: true });
  const { nodes, rels } = snapshot(db);
  db.close();

  const seq = new Map(nodes.filter((n) => typeof n.props.seq === "number").map((n) => [n.id, n.props.seq as number]));
  // A File has no seq: it appears with the first run that read or saved it. A relationship appears with its later end.
  const at = new Map(seq);
  for (const r of rels) if (!seq.has(r.to)) at.set(r.to, Math.min(at.get(r.to) ?? Infinity, seq.get(r.from) ?? 0));
  const relAt = (r: GRel) => Math.max(at.get(r.from) ?? 0, at.get(r.to) ?? 0);

  const answer = new Map(nodes.filter((n) => n.label === "Run").map((n) => [n.id, n.props.answer as Status["state"]]));
  const runs = rels.filter((r) => r.type === "OF").map((r) => ({ run: r.from, question: r.to, seq: seq.get(r.from)! })).sort((a, b) => a.seq - b.seq);
  const questions = nodes.filter((n) => n.label === "Question").map((n) => n.id);

  const states = (t: number): Status[] =>
    questions
      .filter((q) => (at.get(q) ?? 0) <= t)
      .map((q) => {
        const last = runs.findLast((r) => r.question === q && r.seq <= t);
        return { id: q, state: last ? answer.get(last.run)! : "pending", run: last?.run ?? null, was: null, reason: null };
      });

  const times = [...new Set(at.values())].sort((a, b) => a - b);
  return times.map((t) => ({ at: t, nodes: nodes.filter((n) => at.get(n.id) === t), rels: rels.filter((r) => relAt(r) === t), states: states(t) }));
}

export function replay(root: string, { port = 4748, hostname = "127.0.0.1", stepMs = 600 } = {}) {
  if (!existsSync(join(root, ".witness", "graph"))) throw new Error(`There is no Witness store in ${root}/.witness.`);
  const steps = timeline(root);
  const files = join(root, ".witness", "files");
  const timers = new WeakMap<object, Timer>();
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
        let i = 0;
        const next = () => {
          const s = steps[i++];
          if (!s) return;
          ws.send(JSON.stringify({ type: "graph", nodes: s.nodes, rels: s.rels }));
          ws.send(JSON.stringify({ type: "states", states: s.states }));
          ws.send(JSON.stringify({ type: "replay", step: i, of: steps.length }));
          timers.set(ws, setTimeout(next, stepMs));
        };
        next();
      },
      close(ws) {
        clearTimeout(timers.get(ws));
      },
      message() {},
    },
  });
}
