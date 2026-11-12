// witness replay: plays a recorded session back to the page, from a store opened read-only. No agent, hub or uv.
//
// Records come in the order the hub wrote them (seq). A question is "running" from its run's start to its answer,
// then shows the answer it got at the time. Each viewer gets its own playback from the start.
import { existsSync } from "node:fs";
import { join } from "node:path";
import page from "../page/index.html";
import type { GNode, GRel, Status } from "./graph.ts";
import { Relate } from "./relate.ts";

type Step = { at: number; nodes: GNode[]; rels: GRel[]; states: Status[] };

/** The session as steps, one per seq that wrote something. */
export function timeline(root: string): Step[] {
  const db = Relate.open(join(root, ".witness", "graph"), { readOnly: true });
  const nodes = db.query("MATCH (n) RETURN labels(n)[0] AS label, n.id AS id, properties(n) AS props") as GNode[];
  const raw = db.query("MATCH (a)-[r]->(b) RETURN type(r) AS type, a.id AS from, b.id AS to, r.role AS role, r.name AS name") as GRel[];
  db.close();
  const rels = raw.map(({ role, name, ...r }) => ({ ...r, ...(role ? { role } : {}), ...(name ? { name } : {}) }) as GRel);

  const seq = new Map(nodes.filter((n) => typeof n.props.seq === "number").map((n) => [n.id, n.props.seq as number]));
  const answerOf = new Map(rels.filter((r) => r.type === "OF").map((r) => [r.to, r.from])); // run -> answer
  const late = (r: GRel) => r.type === "SAVED" || r.type === "USED" || (r.type === "READ" && r.role === "lock");
  // A relationship appears with the record that wrote it: the answer's for what a run saved, used and locked.
  const relAt = (r: GRel) => (late(r) ? (seq.get(answerOf.get(r.from) ?? "") ?? seq.get(r.from)) : seq.get(r.from)) ?? 0;
  const at = new Map(seq);
  for (const r of rels) for (const end of [r.from, r.to]) if (!seq.has(end)) at.set(end, Math.min(at.get(end) ?? Infinity, relAt(r)));

  const runs = rels.filter((r) => r.type === "ANSWERS").map((r) => ({ run: r.from, question: r.to, start: seq.get(r.from)! }));
  const questions = nodes.filter((n) => n.label === "Question").map((n) => n.id);
  const value = new Map(nodes.filter((n) => n.label === "Answer").map((n) => [n.id, n.props.value as Status["state"]]));

  const states = (t: number): Status[] =>
    questions
      .filter((q) => (at.get(q) ?? 0) <= t)
      .map((q) => {
        const last = runs.filter((r) => r.question === q && r.start <= t).sort((a, b) => a.start - b.start).at(-1);
        const answer = last && answerOf.get(last.run);
        const done = answer && (seq.get(answer) ?? Infinity) <= t;
        return { id: q, state: last ? (done ? value.get(answer!)! : "running") : "pending", run: last?.run ?? null, was: null, reason: null };
      });

  const times = [...new Set([...at.values()])].sort((a, b) => a - b);
  return times.map((t) => ({
    at: t,
    nodes: nodes.filter((n) => at.get(n.id) === t),
    rels: rels.filter((r) => Math.max(relAt(r), at.get(r.from) ?? 0, at.get(r.to) ?? 0) === t),
    states: states(t),
  }));
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
