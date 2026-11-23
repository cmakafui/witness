// A fixed probe can replace a question that settled nothing. Measured evidence can never be replaced.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";

let root: string;
let hub: Hub;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-replaces-"));
  hub = await Hub.open(root, { pollMs: 0 });
});
afterEach(async () => {
  await hub.idle();
  hub.close();
  rmSync(root, { recursive: true, force: true });
});
const head = "# /// script\n# dependencies = []\n# ///\nimport json, os\n";
const fixed = { text: "Is x positive?", rule: "$x > 0", probe: `${head}print('WITNESS_RESULT', '{"x": 1}')` };
const crashing = { ...fixed, probe: `${head}raise SystemExit(2)\nprint('WITNESS_RESULT', '{}')` };
const replaced = () => hub.query("RETURN $replaced AS r").rows[0]!.r;

test("a fix replaces a crash; the crash keeps its answer and goes into $replaced", async () => {
  const crash = await hub.ask(crashing);
  expect(crash.state).toBe("failed");
  const fix = await hub.ask({ ...fixed, replaces: crash.id });
  expect(fix.state).toBe("yes");
  expect(fix.id).not.toBe((await hub.ask(fixed)).id);
  expect(hub.statuses().find((s) => s.id === crash.id)).toMatchObject({ state: "failed", run: crash.run });
  expect(replaced()).toEqual([crash.id]);
  expect(hub.query("MATCH (a:Question)-[:REPLACES]->(b:Question) RETURN a.id AS a, b.id AS b").rows).toEqual([{ a: fix.id, b: crash.id }]);
  expect(hub.query("MATCH (q:Question) WHERE q.id IN $failed AND NOT q.id IN $replaced RETURN count(q) AS n").rows).toEqual([{ n: 0 }]);
  // The same fix asked again is the same question.
  expect((await hub.ask({ ...fixed, replaces: crash.id })).run).toBe(fix.run);
}, 30_000);

test("measured answers cannot be replaced: yes, no, or a rule that failed", async () => {
  const yes = await hub.ask(fixed);
  const no = await hub.ask({ ...fixed, rule: "$x < 0" });
  const undecided = await hub.ask({ ...fixed, rule: "$y > 0" });
  expect([yes.state, no.state, undecided.state]).toEqual(["yes", "no", "failed"]);
  for (const old of [yes, no, undecided])
    await expect(hub.ask({ ...fixed, text: "Is x still positive?", replaces: old.id })).rejects.toThrow(/cannot be replaced/);
  await expect(hub.ask({ ...fixed, replaces: "q-000000000000" })).rejects.toThrow(/no question/);
  await expect(hub.ask({ ...fixed, replaces: "nonsense" })).rejects.toThrow(/question id/);
  expect(replaced()).toEqual([]);
  expect(hub.query("MATCH ()-[r:REPLACES]->() RETURN count(r) AS n").rows).toEqual([{ n: 0 }]);
}, 30_000);

test("a crashed acceptance question is replaced only by the acceptance question of a new goal", async () => {
  const g = hub.goal("x is positive.");
  const crash = await hub.ask({ ...crashing, accepts: g.id });
  expect(crash.state).toBe("failed");
  await expect(hub.ask({ ...fixed, replaces: crash.id })).rejects.toThrow(/Make a new goal/);
  const g2 = hub.goal("x is positive.");
  const fix = await hub.ask({ ...fixed, accepts: g2.id, replaces: crash.id });
  expect(fix.goal).toMatchObject({ id: g2.id, complete: true });
  expect(hub.goals().find((x) => x.id === g.id)).toMatchObject({ acceptance: crash.id, complete: false });
  expect(replaced()).toEqual([crash.id]);
}, 30_000);

test("REPLACES survives a reopen", async () => {
  const crash = await hub.ask(crashing);
  const fix = await hub.ask({ ...fixed, replaces: crash.id });
  await hub.idle();
  hub.close();
  hub = await Hub.open(root, { pollMs: 0 });
  expect(replaced()).toEqual([crash.id]);
  expect(hub.query("MATCH (:Question {id: $id})-[:REPLACES]->(b) RETURN b.id AS b", { id: fix.id }).rows).toEqual([{ b: crash.id }]);
}, 30_000);
