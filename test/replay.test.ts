// A recorded session plays back from the store alone: in order, with runs before answers, and ending as answered.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { replay, timeline } from "../src/replay.ts";

let root: string;
const ids: Record<string, string> = {};
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-replay-"));
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const hub = await Hub.open(root, { pollMs: 0 });
  const head = "# /// script\n# dependencies = []\n# ///\nimport json, os\n";
  const a = await hub.ask({
    text: "Does data.txt hold numbers?",
    rule: "one or more integers",
    inputs: ["data.txt"],
    probe: `${head}n=[int(x) for x in open("data.txt").read().split()]\nassert n\njson.dump(n, open(os.path.join(os.environ["WITNESS_OUT"], "n.json"), "w"))\nprint("WITNESS_ANSWER yes")`,
  });
  const b = await hub.ask({
    text: "Is the total above 100?",
    rule: "sum > 100",
    inputs: [`${a.id}/n.json`],
    disputes: [a.id],
    probe: `${head}n=json.load(open("${a.id}/n.json"))\nprint("WITNESS_ANSWER", "yes" if sum(n) > 100 else "no")`,
  });
  const c = await hub.ask({ text: "Does it crash?", rule: "never", probe: `${head}raise SystemExit(2)\nprint("WITNESS_ANSWER no")` });
  Object.assign(ids, { a: a.id, b: b.id, c: c.id });
  await hub.idle();
  hub.close();
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the timeline brings every record after what it points to, and runs before their answers", () => {
  const steps = timeline(root);
  const seen = new Set<string>();
  let running = false;
  for (const s of steps) {
    for (const n of s.nodes) seen.add(n.id);
    for (const r of s.rels) expect(seen.has(r.from) && seen.has(r.to)).toBe(true);
    if (s.states.some((x) => x.id === ids.a && x.state === "running")) running = true;
  }
  expect(running).toBe(true);
  const last = Object.fromEntries(steps.at(-1)!.states.map((s) => [s.id, s.state]));
  expect(last).toEqual({ [ids.a!]: "yes", [ids.b!]: "no", [ids.c!]: "failed" });
});

test("the page plays the session back into its own Relate copy", async () => {
  const server = replay(root, { port: 0, stepMs: 20 });
  try {
    await using view = new Bun.WebView({ width: 1000, height: 700 });
    await view.navigate(server.url.href);
    let got = "";
    for (let i = 0; i < 100 && got !== "no"; i++) {
      await Bun.sleep(100);
      got = (await view.evaluate(`window.witness ? window.witness.state(${JSON.stringify(ids.b)}) : null`).catch(() => null)) as string;
    }
    expect(got).toBe("no");
    const disputes = await view.evaluate(`window.witness.cypher("MATCH (:Question)-[:DISPUTES]->(q:Question) RETURN q.id AS id")`);
    expect(disputes).toEqual([{ id: ids.a }]);
  } finally {
    server.stop(true);
  }
}, 30_000);
