// The hub, end to end with real uv probes: answers come from runs, follow their inputs, and come back with them.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";

let root: string;
let hub: Hub;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-hub-"));
  hub = await Hub.open(root, { pollMs: 0 });
});
afterEach(async () => {
  await hub.idle();
  hub.close();
  rmSync(root, { recursive: true, force: true });
});

const probe = (body: string, deps: string[] = []) => `# /// script
# requires-python = ">=3.11"
# dependencies = ${JSON.stringify(deps)}
# ///
import json, os
${body}
`;

// Sums the numbers in data.txt, saves the total, and answers yes when there is at least one number.
const sum = probe(`
nums = [int(x) for x in open("data.txt").read().split()]
assert nums, "no numbers: the measurement did not happen"
json.dump({"total": sum(nums)}, open(os.path.join(os.environ["WITNESS_OUT"], "total.json"), "w"))
print("WITNESS_RESULT", json.dumps({"count": len(nums), "total": sum(nums)}))
print("WITNESS_ANSWER yes")
`);

// Reads the total that another question saved, and answers yes when it is more than 10.
const big = (upstream: string) =>
  probe(`
total = json.load(open("${upstream}/total.json"))["total"]
print("WITNESS_RESULT", json.dumps({"total": total}))
print("WITNESS_ANSWER", "yes" if total > 10 else "no")
`);

/** Runs what is pending, again and again, until nothing runs. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    hub.check();
    await hub.idle();
    if (!hub.statuses().some((s) => s.state === "pending" || s.state === "running")) return;
  }
}

test("ask runs the probe and returns its answer, results, outputs and packages", async () => {
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const a = await hub.ask({
    text: "Does data.txt hold at least one number?",
    rule: "yes when the file parses to one or more integers",
    probe: sum.replace("# dependencies = []", '# dependencies = ["packaging==24.2"]'),
    inputs: ["data.txt"],
  });
  expect(a.state).toBe("yes");
  expect(a.results).toEqual([{ count: 3, total: 15 }]);
  expect(a.saved).toEqual([`${a.id}/total.json`]);
  const used = hub.query("MATCH (:Run {id: $run})-[:USED]->(p:Package) RETURN p.id AS id", { run: a.run! }).rows;
  expect(used).toEqual([{ id: "packaging@24.2" }]);
}, 120_000);

test("a probe that crashes has failed; a failed run is never a no", async () => {
  const a = await hub.ask({ text: "Does it crash?", rule: "never decides", probe: probe(`raise SystemExit(3)\nprint("WITNESS_ANSWER no")`) });
  expect(a.state).toBe("failed");
  expect(a.reason).toContain("exit code 3");
}, 60_000);

test("a question builds on another's output, and its answer follows when an input changes", async () => {
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const a = await hub.ask({ text: "Does data.txt hold numbers?", rule: "one or more integers", probe: sum, inputs: ["data.txt"] });
  const b = await hub.ask({ text: "Is the total more than 10?", rule: "total > 10", probe: big(a.id), inputs: [`${a.id}/total.json`] });
  expect(b.state).toBe("yes");
  expect(hub.query("MATCH (b:Question {id: $b})-[:NEEDS]->(a:Question) RETURN a.id AS a", { b: b.id }).rows).toEqual([{ a: a.id }]);

  writeFileSync(join(root, "data.txt"), "1 2");
  await settle();
  expect(hub.status(a.id).state).toBe("yes");
  expect(hub.status(b.id)).toMatchObject({ state: "no" });
}, 120_000);

test("an old answer comes back when its inputs do, without a new run", async () => {
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const a = await hub.ask({ text: "Does data.txt hold numbers?", rule: "one or more integers", probe: sum, inputs: ["data.txt"] });
  const b = await hub.ask({ text: "Is the total more than 10?", rule: "total > 10", probe: big(a.id), inputs: [`${a.id}/total.json`] });
  writeFileSync(join(root, "data.txt"), "1 2");
  await settle();
  const runs = () => Number(hub.query("MATCH (r:Run) RETURN count(r) AS n").rows[0]!.n);
  const before = runs();
  writeFileSync(join(root, "data.txt"), "4 5 6");
  await settle();
  expect(hub.status(b.id).state).toBe("yes");
  expect(runs()).toBe(before);
}, 120_000);

test("asking the same question twice is one question", async () => {
  const ask = () => hub.ask({ text: "Is 2 even?", rule: "2 % 2 == 0", probe: probe(`print("WITNESS_ANSWER", "yes" if 2 % 2 == 0 else "no")`) });
  const [x, y] = [await ask(), await ask()];
  expect(x.id).toBe(y.id);
  expect(hub.query("MATCH (q:Question) RETURN count(q) AS n").rows).toEqual([{ n: 1 }]);
  expect(hub.query("MATCH (r:Run) RETURN count(r) AS n").rows).toEqual([{ n: 1 }]);
}, 60_000);

test("a question can dispute another, and query finds yes answers that nothing disputes", async () => {
  const yes = probe(`print("WITNESS_ANSWER yes")`);
  const a = await hub.ask({ text: "Is A true?", rule: "always", probe: yes });
  const b = await hub.ask({ text: "Is B true?", rule: "always", probe: yes });
  await hub.ask({ text: "Is A false after all?", rule: "never", probe: probe(`print("WITNESS_ANSWER no")`), disputes: [a.id] });
  const undisputed = hub.query("MATCH (q:Question) WHERE q.id IN $yes AND NOT EXISTS { (:Question)-[:DISPUTES]->(q) } RETURN q.id AS id").rows;
  expect(undisputed).toEqual([{ id: b.id }]);
}, 60_000);

test("query cannot write", () => {
  expect(() => hub.query("CREATE (:Note {text: 'x'})")).toThrow(/read/i);
});

test("ask refuses a probe that never answers, and an input outside the workspace", async () => {
  await expect(hub.ask({ text: "x?", rule: "r", probe: "# /// script\n# ///\nprint(1)" })).rejects.toThrow(/WITNESS_ANSWER/);
  await expect(hub.ask({ text: "x?", rule: "r", probe: probe(`print("WITNESS_ANSWER yes")`), inputs: ["../etc/passwd"] })).rejects.toThrow(/outside/);
});
