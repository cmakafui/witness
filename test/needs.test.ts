// NEEDS names the file a question reads from another: one edge per q-…/file input.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_RELS, type GRel, statements, UNIQUE_IDS } from "../src/graph.ts";
import { Hub } from "../src/hub.ts";
import { type Param, Relate } from "../src/relate.ts";

let root: string;
let hub: Hub;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-needs-"));
  hub = await Hub.open(root, { pollMs: 0 });
});
afterEach(async () => {
  await hub.idle();
  hub.close();
  rmSync(root, { recursive: true, force: true });
});

const head = "# /// script\n# dependencies = []\n# ///\nimport json, os\n";
const two = `${head}for n in ("a.json", "b.json"):\n    open(os.path.join(os.environ["WITNESS_OUT"], n), "w").write("1")\nprint("WITNESS_RESULT", json.dumps({"saved": 2}))`;
const reads = (files: string[]) => `${head}print("WITNESS_RESULT", json.dumps({"read": sum(int(open(f).read()) for f in ${JSON.stringify(files)})}))`;

/** The page's path: write a snapshot into a fresh copy with the same statements, and read the edges back. */
function replayed(): { from: string; to: string; name: string | null }[] {
  const copy = Relate.open(":memory:");
  try {
    for (const c of UNIQUE_IDS) copy.query(c);
    // Read the edges as the page reads a copy, with ALL_RELS: an edge without a name comes back with name null.
    const { nodes } = hub.snapshot();
    const rels = hub.query(ALL_RELS, {}, 100_000).rows as GRel[];
    for (const s of statements(nodes, rels)) copy.query(s.cypher, s.params as Record<string, Param>);
    return copy.query("MATCH (a)-[n:NEEDS]->(b) RETURN a.id AS from, b.id AS to, n.name AS name ORDER BY name") as never;
  } finally {
    copy.close();
  }
}

test("each file read from another question gets its own NEEDS, named by the input", async () => {
  const producer = await hub.ask({ text: "Does it save two files?", rule: "$saved = 2", probe: two });
  const inputs = [`${producer.id}/b.json`, `${producer.id}/a.json`];
  const consumer = await hub.ask({ text: "Do both files hold 1?", rule: "$read = 2", probe: reads(["a.json", "b.json"].map((f) => `${producer.id}/${f}`)), inputs });
  expect(consumer.state).toBe("yes");
  const edges = hub.query("MATCH (c:Question {id: $c})-[n:NEEDS]->(p:Question) RETURN p.id AS p, n.name AS name ORDER BY name", { c: consumer.id }).rows;
  expect(edges).toEqual([
    { p: producer.id, name: `${producer.id}/a.json` },
    { p: producer.id, name: `${producer.id}/b.json` },
  ]);
  // Two edges, one producer: a walk over NEEDS counts questions with DISTINCT.
  expect(hub.query("MATCH (:Question {id: $c})-[:NEEDS*1..3]->(u) RETURN count(DISTINCT u) AS n", { c: consumer.id }).rows).toEqual([{ n: 1 }]);
  expect(replayed()).toEqual(edges.map((e) => ({ from: consumer.id, to: String(e.p), name: String(e.name) })));
}, 60_000);

test("the recorded session, made before NEEDS had a name, still replays", async () => {
  const recorded = join(import.meta.dir, "..", "examples", "human-rng", ".witness");
  await hub.idle();
  hub.close();
  rmSync(join(root, ".witness"), { recursive: true, force: true });
  cpSync(recorded, join(root, ".witness"), { recursive: true });
  hub = await Hub.open(root, { pollMs: 0 });
  const all = Number(hub.query("MATCH ()-[n:NEEDS]->() RETURN count(n) AS all").rows[0]!.all);
  expect(all).toBeGreaterThan(0);
  expect(replayed().length).toBe(all);
  // The recorded store itself is never written.
  expect(existsSync(join(recorded, "graph", ".relate"))).toBe(false);
}, 60_000);
