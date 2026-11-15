// Completion follows one current acceptance answer, never the successes or failures of exploration.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";

let root: string;
let hub: Hub;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-goals-"));
  hub = await Hub.open(root, { pollMs: 0 });
});
afterEach(async () => {
  await hub.idle();
  hub.close();
  rmSync(root, { recursive: true, force: true });
});
const head = "# /// script\n# dependencies = []\n# ///\nimport json, os\n";
const testQuestion = { text: "Is x positive?", rule: "$x > 0", probe: `${head}print('WITNESS_RESULT', '{"x": 1}')` };
const goal = (id: string) => hub.goals().find((g) => g.id === id)!;
const completion = () => hub.query("RETURN $complete AS complete, $incomplete AS incomplete").rows[0];
async function settle() {
  for (let i = 0; i < 20; i++) {
    hub.check();
    await hub.idle();
    if (!hub.statuses().some((s) => s.state === "pending" || s.state === "running")) return;
  }
  throw new Error("questions did not settle");
}

test("goals start open, exploration never votes, and an acceptance binding precedes execution", async () => {
  expect(() => hub.goal("  ")).toThrow(/solved condition/);
  const g = hub.goal("The candidate passes the independent check.");
  expect(g).toMatchObject({ acceptance: null, state: "open", complete: false });
  expect(completion()).toEqual({ complete: [], incomplete: [g.id] });
  const yes = await hub.ask(testQuestion);
  const no = await hub.ask({ ...testQuestion, rule: "$x < 0" });
  const failed = await hub.ask({ ...testQuestion, probe: `${head}raise SystemExit(2)\nprint('WITNESS_RESULT', '{}')` });
  expect([yes.state, no.state, failed.state]).toEqual(["yes", "no", "failed"]);
  expect(goal(g.id)).toMatchObject({ acceptance: null, state: "open", complete: false });
  let beforeRun = false;
  const off = hub.on((e) => {
    if (e.type !== "graph" || !e.rels.some((r) => r.type === "ACCEPTED_BY")) return;
    const bound = goal(g.id).acceptance!;
    expect(hub.query("MATCH (:Run)-[:OF]->(:Question {id: $id}) RETURN count(*) AS n", { id: bound }).rows).toEqual([{ n: 0 }]);
    beforeRun = true;
  });
  const accepted = await hub.ask({ ...testQuestion, accepts: g.id });
  off();
  expect(beforeRun).toBe(true);
  expect(accepted.id).not.toBe(yes.id);
  expect(accepted.goal).toMatchObject({ id: g.id, acceptance: accepted.id, state: "yes", complete: true });
  expect(completion()).toEqual({ complete: [g.id], incomplete: [] });
  // Later negative and failed explorations do not undo completion either.
  await hub.ask({ ...testQuestion, text: "Does another candidate work?", rule: "$x < 0" });
  expect(goal(g.id).complete).toBe(true);
}, 30_000);

test("competing contracts cannot replace a binding, retries reuse it, and a new goal can reuse the text", async () => {
  const g = hub.goal("x is positive");
  const attempts = await Promise.allSettled([
    hub.ask({ ...testQuestion, accepts: g.id }),
    hub.ask({ ...testQuestion, rule: "$x >= 1", accepts: g.id }),
  ]);
  expect(attempts.map((a) => a.status)).toEqual(["fulfilled", "rejected"]);
  expect((attempts[1] as PromiseRejectedResult).reason.message).toContain("Create a new goal");
  const accepted = (attempts[0] as PromiseFulfilledResult<Awaited<ReturnType<Hub["ask"]>>>).value;
  const retry = await hub.ask({ ...testQuestion, accepts: g.id, asker: "retry" });
  expect([retry.id, retry.run]).toEqual([accepted.id, accepted.run]);
  expect(hub.query("MATCH (:Goal {id: $id})-[:ACCEPTED_BY]->(:Question) RETURN count(*) AS n", { id: g.id }).rows).toEqual([{ n: 1 }]);
  expect(hub.query("MATCH (q:Question) RETURN count(*) AS n").rows).toEqual([{ n: 1 }]);
  await expect(hub.ask({ ...testQuestion, accepts: "g-missing" })).rejects.toThrow(/no goal/);
  const replacement = hub.goal(g.text);
  expect(replacement.id).not.toBe(g.id);
  await hub.ask({ ...testQuestion, rule: "$x >= 1", accepts: replacement.id });
  // Reopening the store preserves the contract and derived completion.
  await hub.idle();
  hub.close();
  hub = await Hub.open(root, { pollMs: 0 });
  expect(goal(g.id)).toMatchObject({ acceptance: accepted.id, complete: true });
  await expect(hub.ask({ ...testQuestion, rule: "$x > 2", accepts: g.id })).rejects.toThrow(/contract cannot change/);
}, 30_000);

test("an acceptance question is bound and run separately; it cannot promote an earlier run", async () => {
  const a = hub.goal("Goal A"), b = hub.goal("Goal B");
  const original = await hub.ask({ ...testQuestion, asker: "first" });
  const again = await hub.ask({ ...testQuestion, asker: "other" });
  expect([again.id, again.run, again.goal]).toEqual([original.id, original.run, null]);
  expect(hub.query("MATCH (q:Question) RETURN q.asker AS asker").rows).toEqual([{ asker: "first" }]);
  const acceptance = await hub.ask({ ...testQuestion, accepts: a.id });
  expect(acceptance.id).not.toBe(original.id);
  expect(acceptance.run).not.toBe(original.run);
  expect(goal(a.id).complete).toBe(true);
  expect(goal(b.id).complete).toBe(false);
}, 30_000);

test("completion follows pending, running, no, failed and restored inputs without storing a completion flag", async () => {
  writeFileSync(join(root, "candidate.txt"), "1");
  const g = hub.goal("The candidate is positive");
  const a = {
    ...testQuestion, accepts: g.id, inputs: ["candidate.txt"],
    probe: `${head}import time\ntime.sleep(0.2)\nx = int(open('candidate.txt').read())\nprint('WITNESS_RESULT', json.dumps({'x': x}))`,
  };
  const accepted = await hub.ask(a);
  expect(goal(g.id).complete).toBe(true);
  writeFileSync(join(root, "candidate.txt"), "-2");
  expect(goal(g.id)).toMatchObject({ state: "pending", complete: false });
  expect(completion()).toEqual({ complete: [], incomplete: [g.id] });
  hub.check();
  expect(goal(g.id)).toMatchObject({ state: "running", complete: false });
  await settle();
  expect(goal(g.id)).toMatchObject({ state: "no", complete: false });
  writeFileSync(join(root, "candidate.txt"), "broken");
  await settle();
  expect(goal(g.id)).toMatchObject({ state: "failed", complete: false, reason: expect.stringContaining("invalid literal") });
  const runs = hub.query("MATCH (r:Run) RETURN count(*) AS n").rows;
  writeFileSync(join(root, "candidate.txt"), "1");
  expect(goal(g.id)).toMatchObject({ state: "yes", complete: true });
  expect((await hub.ask(a)).run).toBe(accepted.run);
  expect(hub.query("MATCH (r:Run) RETURN count(*) AS n").rows).toEqual(runs);
  expect(hub.query("MATCH (g:Goal) RETURN g.complete AS complete, g.state AS state").rows).toEqual([{ complete: null, state: null }]);
}, 30_000);

test("acceptance waits for changed upstream artifacts, even when the upstream question is exploratory", async () => {
  writeFileSync(join(root, "candidate.txt"), "1");
  const g = hub.goal("A positive candidate is saved");
  const upstream = await hub.ask({ ...testQuestion, inputs: ["candidate.txt"],
    probe: `${head}x = int(open('candidate.txt').read())\nopen(os.path.join(os.environ['WITNESS_OUT'], 'x.txt'), 'w').write(str(x))\nprint('WITNESS_RESULT', json.dumps({'x': x}))` });
  const acceptance = await hub.ask({ ...testQuestion, accepts: g.id, inputs: [`${upstream.id}/x.txt`],
    probe: `${head}x = int(open('${upstream.id}/x.txt').read())\nprint('WITNESS_RESULT', json.dumps({'x': x}))` });
  expect(goal(g.id).complete).toBe(true);
  writeFileSync(join(root, "candidate.txt"), "-2");
  expect(goal(g.id)).toMatchObject({ state: "waiting", complete: false, reason: expect.any(String) });
  await settle();
  expect(goal(g.id)).toMatchObject({ state: "no", complete: false });
  writeFileSync(join(root, "candidate.txt"), "1");
  expect(goal(g.id).complete).toBe(true);
  expect(hub.status(acceptance.id).run).toBe(acceptance.run);
}, 30_000);
