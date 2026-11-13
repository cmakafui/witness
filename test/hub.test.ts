// The hub, end to end with real uv probes: answers come from runs, follow their inputs, and come back with them.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Sums the numbers in data.txt and saves the total. It crashes when there is no number: nothing was measured.
const sum = probe(`
nums = [int(x) for x in open("data.txt").read().split()]
assert nums, "no numbers: the measurement did not happen"
json.dump({"total": sum(nums)}, open(os.path.join(os.environ["WITNESS_OUT"], "total.json"), "w"))
print("WITNESS_RESULT", json.dumps({"count": len(nums), "total": sum(nums)}))
`);

// Reads the total that another question saved.
const big = (upstream: string) =>
  probe(`
total = json.load(open("${upstream}/total.json"))["total"]
print("WITNESS_RESULT", json.dumps({"total": total}))
`);

// Prints one measurement as it is given.
const measure = (m: Record<string, unknown>) => probe(`print("WITNESS_RESULT", ${JSON.stringify(JSON.stringify(m))})`);

/** Runs what is pending, again and again, until nothing runs. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    hub.check();
    await hub.idle();
    if (!hub.statuses().some((s) => s.state === "pending" || s.state === "running")) return;
  }
}

test("ask runs the probe, the rule decides, and the run records its measurements, outputs and packages", async () => {
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const a = await hub.ask({
    text: "Does data.txt hold at least one number?",
    rule: "$count >= 1",
    probe: sum.replace("# dependencies = []", '# dependencies = ["packaging==24.2"]'),
    inputs: ["data.txt"],
  });
  expect(a.state).toBe("yes");
  expect(a.results).toEqual([{ count: 3, total: 15 }]);
  expect(a.saved).toEqual([`${a.id}/total.json`]);
  const [run] = hub.query("MATCH (r:Run {id: $run})-[:OF]->(q:Question) RETURN r.answer AS answer, r.packages AS packages, q.rule AS rule", { run: a.run! }).rows;
  expect(run).toEqual({ answer: "yes", packages: ["packaging==24.2"], rule: "$count >= 1" });
}, 120_000);

test("the rule sees each measurement by name, and every measurement as $results", async () => {
  const sweep = probe(`for e in [0.1, 0.2, 0.25]:\n    print("WITNESS_RESULT", json.dumps({"error": e}))`);
  const all = await hub.ask({ text: "Is every error at most 0.3?", rule: "all(r IN $results WHERE r.error <= 0.3)", probe: sweep });
  expect(all.state).toBe("yes");
  const last = await hub.ask({ text: "Is the last error below 0.2?", rule: "$error < 0.2", probe: sweep });
  expect(last.state).toBe("no");
}, 60_000);

test("a rule that needs a measurement the run did not make has failed, never no", async () => {
  const a = await hub.ask({ text: "Is p small?", rule: "$p < 0.01", probe: measure({ gain: 0.2 }) });
  expect(a).toMatchObject({ state: "failed", reason: "the run did not measure p, which the rule needs" });
  const b = await hub.ask({ text: "Is p small, when p is null?", rule: "$p < 0.01", probe: measure({ p: null }) });
  expect(b.state).toBe("failed");
  const c = await hub.ask({ text: "Is p plus one a yes?", rule: "$p + 1", probe: measure({ p: 1 }) });
  expect(c).toMatchObject({ state: "failed", reason: "the rule's value is 2, not true or false" });
}, 60_000);

test("a probe that crashes, or measures nothing, has failed", async () => {
  const a = await hub.ask({ text: "Does it crash?", rule: "$x = 1", probe: probe(`raise SystemExit(3)\nprint("WITNESS_RESULT", "{}")`) });
  expect(a.state).toBe("failed");
  expect(a.reason).toContain("exit code 3");
  const b = await hub.ask({ text: "Does it measure?", rule: "$x = 1", probe: probe(`if False: print("WITNESS_RESULT", "{}")`) });
  expect(b).toMatchObject({ state: "failed", reason: "measured nothing: it printed no WITNESS_RESULT line" });
}, 60_000);

test("a question builds on another's output, and its answer follows when an input changes", async () => {
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const a = await hub.ask({ text: "Does data.txt hold numbers?", rule: "$count >= 1", probe: sum, inputs: ["data.txt"] });
  const b = await hub.ask({ text: "Is the total more than 10?", rule: "$total > 10", probe: big(a.id), inputs: [`${a.id}/total.json`] });
  expect(b.state).toBe("yes");
  expect(hub.query("MATCH (b:Question {id: $b})-[:NEEDS]->(a:Question) RETURN a.id AS a", { b: b.id }).rows).toEqual([{ a: a.id }]);

  writeFileSync(join(root, "data.txt"), "1 2");
  await settle();
  expect(hub.status(a.id).state).toBe("yes");
  expect(hub.status(b.id)).toMatchObject({ state: "no" });
}, 120_000);

test("an old answer comes back when its inputs do, without a new run", async () => {
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const a = await hub.ask({ text: "Does data.txt hold numbers?", rule: "$count >= 1", probe: sum, inputs: ["data.txt"] });
  const b = await hub.ask({ text: "Is the total more than 10?", rule: "$total > 10", probe: big(a.id), inputs: [`${a.id}/total.json`] });
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
  const ask = () => hub.ask({ text: "Is 2 even?", rule: "$rem = 0", probe: measure({ rem: 0 }) });
  const [x, y] = [await ask(), await ask()];
  expect(x.id).toBe(y.id);
  expect(hub.query("MATCH (q:Question) RETURN count(q) AS n").rows).toEqual([{ n: 1 }]);
  expect(hub.query("MATCH (r:Run) RETURN count(r) AS n").rows).toEqual([{ n: 1 }]);
}, 60_000);

test("a dispute answered yes refutes the claim it disputes; one answered no leaves it standing", async () => {
  const one = measure({ x: 1 });
  const a = await hub.ask({ text: "Is A true?", rule: "$x = 1", probe: one });
  const b = await hub.ask({ text: "Is B true?", rule: "$x = 1", probe: one });
  await hub.ask({ text: "Is A false after all?", rule: "$x = 1", probe: one, disputes: [a.id] });
  await hub.ask({ text: "Is B false after all?", rule: "$x = 2", probe: one, disputes: [b.id] });
  expect(hub.query("MATCH (q:Question) WHERE q.id IN $refuted RETURN q.id AS id").rows).toEqual([{ id: a.id }]);
  const standing = hub.query("MATCH (q:Question)<-[:DISPUTES]-(:Question) WHERE q.id IN $yes AND NOT q.id IN $refuted RETURN q.id AS id").rows;
  expect(standing).toEqual([{ id: b.id }]);
}, 60_000);

test("a new store keeps the graph as one readable graph.json", async () => {
  await hub.ask({ text: "Is 2 even?", rule: "$rem = 0", probe: measure({ rem: 0 }) });
  hub.close();
  hub = await Hub.open(root, { pollMs: 0 });
  const graph = await Bun.file(join(root, ".witness", "graph", "graph.json")).json();
  expect(graph.nodes.some((n: { labels: string[]; properties: { text?: string } }) => n.labels[0] === "Question" && n.properties.text === "Is 2 even?")).toBe(true);
}, 60_000);

test("a store made by another format of Witness is refused, not changed", async () => {
  const old = mkdtempSync(join(tmpdir(), "witness-old-"));
  try {
    mkdirSync(join(old, ".witness", "graph"), { recursive: true });
    await expect(Hub.open(old, { pollMs: 0 })).rejects.toThrow(/older Witness/);
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
});

test("query cannot write", () => {
  expect(() => hub.query("CREATE (:Note {text: 'x'})")).toThrow(/read/i);
});

test("ask refuses a rule that is not an expression over measurements, a probe that answers, and an outside input", async () => {
  const ok = measure({ x: 1 });
  await expect(hub.ask({ text: "x?", rule: "", probe: ok })).rejects.toThrow(/no rule/);
  await expect(hub.ask({ text: "x?", rule: "yes when x is 1", probe: ok })).rejects.toThrow(/names no measurement/);
  await expect(hub.ask({ text: "x?", rule: "$x = 1 RETURN 1 AS answer UNION MATCH (n) RETURN true", probe: ok })).rejects.toThrow(/RETURN is not part of one/);
  await expect(hub.ask({ text: "x?", rule: "$x <", probe: ok })).rejects.toThrow(/not a Cypher expression/);
  await expect(hub.ask({ text: "x?", rule: "$x = 1", probe: probe(`print("WITNESS_ANSWER yes")`) })).rejects.toThrow(/does not answer/);
  await expect(hub.ask({ text: "x?", rule: "$x = 1", probe: "# /// script\n# ///\nprint(1)" })).rejects.toThrow(/never prints WITNESS_RESULT/);
  await expect(hub.ask({ text: "x?", rule: "$x = 1", probe: ok, inputs: ["../etc/passwd"] })).rejects.toThrow(/outside/);
});
