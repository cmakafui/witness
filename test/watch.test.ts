// Watch: an agent waits for the questions and runs that the hub records in a lane. It reads the record log after a cursor.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";

let root: string;
let hub: Hub;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-watch-"));
  hub = await Hub.open(root, { pollMs: 0 });
});
afterEach(async () => {
  await hub.idle();
  hub.close();
  rmSync(root, { recursive: true, force: true });
});

const probe = (body: string) => `# /// script\n# dependencies = []\n# ///\nimport json, time\n${body}\n`;
const measure = (x: number, sleep = 0) => probe(`time.sleep(${sleep})\nprint("WITNESS_RESULT", json.dumps({"x": ${x}}))`);

test("since reads the questions and runs after a cursor, in one lane or in all", async () => {
  const a = await hub.ask({ text: "Is x positive in a?", rule: "$x > 0", probe: measure(1), lane: "a" });
  const b = await hub.ask({ text: "Is x positive in b?", rule: "$x > 0", probe: measure(-1), lane: "b" });
  expect(hub.since(0).events.map((e) => [e.kind, e.question])).toEqual([["asked", a.id], ["answered", a.id], ["asked", b.id], ["answered", b.id]]);
  const inA = hub.since(0, "a");
  expect(inA.events).toEqual([
    { seq: expect.any(Number), kind: "asked", question: a.id, lane: "a" },
    { seq: expect.any(Number), kind: "answered", question: a.id, lane: "a", answer: "yes", run: a.run! },
  ]);
  // The cursor covers lane b's records too: the next read of lane a starts after them.
  expect(inA.cursor).toBe(hub.since(0).events.at(-1)!.seq);
  expect(hub.since(inA.cursor, "a").events).toEqual([]);
  expect(hub.since(0, "b").events.map((e) => e.answer)).toEqual([undefined, "no"]);
}, 60_000);

test("a long read returns 100 events, and its cursor gives the rest without a gap", async () => {
  const up = await hub.ask({ text: "Does the source crash?", rule: "$x > 0", probe: probe(`raise SystemExit(1)\nprint("WITNESS_RESULT", json.dumps({"x": 1}))`) });
  // Each question waits for the crashed source, so it adds one record and no run.
  const wait = (i: number, lane: string) => hub.ask({ text: `Does reader ${i} wait?`, rule: "$x > 0", probe: measure(i), inputs: [`${up.id}/x`], lane });
  for (let i = 0; i < 101; i++) {
    await wait(i, "many");
    if (i === 99) await wait(i, "other");
  }
  const first = hub.since(0, "many");
  expect(first.events).toHaveLength(100);
  const rest = hub.since(first.cursor, "many");
  expect(rest.events.map((e) => e.lane)).toEqual(["many"]);
  expect(new Set([...first.events, ...rest.events].map((e) => e.question)).size).toBe(101);
  expect(hub.since(rest.cursor, "many").events).toEqual([]);
}, 60_000);

test("a watch returns when another agent's question is recorded, and again when its run ends", async () => {
  const watching = hub.watch({ lane: "x", waitS: 30 });
  await hub.ask({ text: "Is y positive?", rule: "$x > 0", probe: measure(1), lane: "y" });
  const asking = hub.ask({ text: "After a second, is x positive?", rule: "$x > 0", probe: measure(1, 1), lane: "x" });
  const asked = await watching;
  expect(asked.events.map((e) => [e.kind, e.lane])).toEqual([["asked", "x"]]);
  const answered = await hub.watch({ after: asked.cursor, lane: "x", waitS: 30 });
  const a = await asking;
  expect(answered.events).toEqual([{ seq: expect.any(Number), kind: "answered", question: a.id, lane: "x", answer: "yes", run: a.run! }]);
  expect(asked.events[0]!.question).toBe(a.id);
}, 60_000);

test("a watch with nothing to see returns no events at the deadline, with a cursor that misses nothing next", async () => {
  await hub.ask({ text: "Is x positive before the watch?", rule: "$x > 0", probe: measure(1) });
  const quiet = await hub.watch({ waitS: 1 });
  expect(quiet.events).toEqual([]);
  const later = await hub.ask({ text: "Is x positive after the watch?", rule: "$x > 0", probe: measure(1) });
  expect(hub.since(quiet.cursor).events.map((e) => [e.kind, e.question])).toEqual([["asked", later.id], ["answered", later.id]]);
}, 60_000);
