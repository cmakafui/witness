// The hub, end to end with real uv probes: answers come from runs, follow their inputs, and come back with them.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

test("ask resolves script dependencies, records measurements and outputs, and keeps only input and output files", async () => {
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const a = await hub.ask({
    text: "Does data.txt hold at least one number?",
    rule: "$count >= 1",
    probe: sum.replace("# dependencies = []", '# dependencies = ["packaging==24.2"]\n# [tool.uv]\n# exclude-newer = "2026-11-01T00:00:00Z"') +
      '\nimport packaging\nassert packaging.__version__ == "24.2"\nassert not os.path.exists("probe.py.lock")\n',
    inputs: ["data.txt"],
  });
  expect(a.state).toBe("yes");
  expect(a.results).toEqual([{ count: 3, total: 15 }]);
  expect(a.saved).toEqual([`${a.id}/total.json`]);
  const [run] = hub.query("MATCH (r:Run {id: $run})-[:OF]->(q:Question) RETURN r.answer AS answer, q.rule AS rule", { run: a.run! }).rows;
  expect(run).toEqual({ answer: "yes", rule: "$count >= 1" });
  const files = hub.query("MATCH (f:File) RETURN f.id AS id").rows.map((f) => String(f.id)).sort();
  expect(files).toHaveLength(2);
  expect(readdirSync(join(root, ".witness", "files")).sort()).toEqual(files);
}, 120_000);

test("the rule sees each measurement by name, and every measurement as $results", async () => {
  const sweep = probe(`for e in [0.1, 0.2, 0.25]:\n    print("WITNESS_RESULT", json.dumps({"error": e}))`);
  const all = await hub.ask({ text: "Is every error at most 0.3?", rule: "all(r IN $results WHERE r.error <= 0.3)", probe: sweep });
  expect(all.state).toBe("yes");
  const last = await hub.ask({ text: "Is the last error below 0.2?", rule: "$error < 0.2", probe: sweep });
  expect(last.state).toBe("no");
}, 60_000);

test("each run records when it started and how long it took", async () => {
  const a = await hub.ask({ text: "Is the gain above 0.1?", rule: "$gain > 0.1", probe: measure({ gain: 0.2 }) });
  const [t] = hub.query("MATCH (r:Run {id: $run}) RETURN r.started AS started, r.ms AS ms", { run: a.run! }).rows as { started: number; ms: number }[];
  expect(t!.started).toBeGreaterThan(1.7e12);
  expect(t!.ms).toBeGreaterThan(0);
}, 60_000);

test("measurements appear together in the committed run, with only graph and state events", async () => {
  const events: string[] = [];
  hub.on((e) => events.push(e.type));
  const a = await hub.ask({
    text: "Are both measurements below 3?",
    rule: "all(r IN $results WHERE r.x < 3)",
    probe: probe('import time\nprint("WITNESS_RESULT", json.dumps({"x": 1}))\ntime.sleep(0.1)\nprint("WITNESS_RESULT", json.dumps({"x": 2}))'),
  });
  expect(a.state).toBe("yes");
  expect(a.results).toEqual([{ x: 1 }, { x: 2 }]);
  expect([...new Set(events)].sort()).toEqual(["graph", "states"]);
  const [run] = hub.query("MATCH (r:Run {id: $run}) RETURN r.results AS results", { run: a.run! }).rows;
  expect(JSON.parse(String(run!.results))).toEqual(a.results);
}, 60_000);

test("a rule that needs a measurement the run did not make has failed, never no", async () => {
  const a = await hub.ask({ text: "Is p small?", rule: "$p < 0.01", probe: measure({ gain: 0.2 }) });
  expect(a).toMatchObject({ state: "failed", reason: "the run did not measure p, which the rule needs" });
  const b = await hub.ask({ text: "Is p small, when p is null?", rule: "$p < 0.01", probe: measure({ p: null }) });
  expect(b.state).toBe("failed");
  const c = await hub.ask({ text: "Is p plus one a yes?", rule: "$p + 1", probe: measure({ p: 1 }) });
  expect(c).toMatchObject({ state: "failed", reason: "the rule's value is 2, not true or false" });
}, 60_000);

test("a null rule names the part that is null, and says how to give a missing value a meaning", async () => {
  const rows = measure({ n: 2, rows: [{ a: 6 }, { a: 6, error: 0.5 }] });
  const a = await hub.ask({ text: "Is any error small?", rule: "$n = 2 AND any(r IN $rows WHERE r.error < 0.3)", probe: rows });
  expect(a.state).toBe("failed");
  expect(a.reason).toContain("in any(r IN $rows WHERE r.error < 0.3)");
  expect(a.reason).toContain("A row without a field gives null");
  const b = await hub.ask({ text: "Is any error small, when a missing error is large?", rule: "any(r IN $rows WHERE coalesce(r.error, 1.0) < 0.3)", probe: rows });
  expect(b.state).toBe("no");
}, 60_000);

test("a question reads the files of a run that measured but whose rule could not decide, and never those of a crash", async () => {
  const save = (then: string) => probe(`json.dump({"total": 12}, open(os.path.join(os.environ["WITNESS_OUT"], "total.json"), "w"))\n${then}`);
  const a = await hub.ask({ text: "Is p small, when p is null?", rule: "$p < 0.01", probe: save(`print("WITNESS_RESULT", json.dumps({"p": None}))`) });
  expect(a.state).toBe("failed");
  const b = await hub.ask({ text: "Is the undecided total more than 10?", rule: "$total > 10", probe: big(a.id), inputs: [`${a.id}/total.json`] });
  expect(b.state).toBe("yes");

  const c = await hub.ask({ text: "Does it crash after it saves?", rule: "$p < 0.01", probe: save(`print("WITNESS_RESULT", json.dumps({"p": 1}))\nraise SystemExit(3)`) });
  expect(c.state).toBe("failed");
  const d = await hub.ask({ text: "Is the crashed total more than 10?", rule: "$total > 10", probe: big(c.id), inputs: [`${c.id}/total.json`] });
  expect(d.state).toBe("waiting");
  expect(d.reason).toContain(`${c.id} did not measure, so its files cannot be read. Ask ${c.id} again to retry it. exit code 3`);
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
  expect(hub.query("MATCH (b:Question {id: $b})-[n:NEEDS]->(a:Question) RETURN a.id AS a, n.name AS name", { b: b.id }).rows).toEqual([{ a: a.id, name: `${a.id}/total.json` }]);

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

test("query cannot write", () => {
  expect(() => hub.query("CREATE (:Note {text: 'x'})")).toThrow(/read/i);
});

test("a rule sees only the measurements: it is evaluated on an empty store, not on the graph", async () => {
  const first = await hub.ask({ text: "Is x one?", rule: "$x = 1", probe: measure({ x: 1 }) });
  expect(first.state).toBe("yes");
  // The graph holds a question and a run now. A rule that looks for nodes finds none.
  const blind = await hub.ask({ text: "Does a rule see the graph?", rule: "$x = 1 AND COUNT { MATCH (n) } = 0", probe: measure({ x: 1 }) });
  expect(blind.state).toBe("yes");
});

test("ask refuses a rule that is not an expression over measurements, a probe that measures nothing, and an outside input", async () => {
  const ok = measure({ x: 1 });
  await expect(hub.ask({ text: "x?", rule: "", probe: ok })).rejects.toThrow(/no rule/);
  await expect(hub.ask({ text: "x?", rule: "yes when x is 1", probe: ok })).rejects.toThrow(/names no measurement/);
  await expect(hub.ask({ text: "x?", rule: "$x = 1 RETURN 1 AS answer UNION MATCH (n) RETURN true", probe: ok })).rejects.toThrow(/not a Cypher expression/);
  await expect(hub.ask({ text: "x?", rule: "$x <", probe: ok })).rejects.toThrow(/not a Cypher expression/);
  await expect(hub.ask({ text: "x?", rule: "$x = 1", probe: "# /// script\n# ///\nprint(1)" })).rejects.toThrow(/never prints WITNESS_RESULT/);
  await expect(hub.ask({ text: "x?", rule: "$x = 1", probe: ok, inputs: ["../etc/passwd"] })).rejects.toThrow(/outside/);
});

test("ask refuses a probe with dependencies and no fixed exclude-newer date", async () => {
  const withDeps = (uv: string) => `# /// script\n# dependencies = ["tomli"]\n${uv}# ///\nimport json\nprint("WITNESS_RESULT", json.dumps({"x": 1}))\n`;
  await expect(hub.ask({ text: "x?", rule: "$x = 1", probe: withDeps("") })).rejects.toThrow(/exclude-newer = "\d{4}-\d{2}-\d{2}T00:00:00Z"/);
  await expect(hub.ask({ text: "x?", rule: "$x = 1", probe: withDeps('# [tool.uv]\n# exclude-newer = "1 week"\n') })).rejects.toThrow(/fixed date/);
  const pinned = await hub.ask({ text: "x?", rule: "$x = 1", probe: withDeps('# [tool.uv]\n# exclude-newer = "2026-11-01T00:00:00Z"\n') });
  expect(pinned.state).toBe("yes");
  // A probe without dependencies installs nothing, so it needs no date.
  expect((await hub.ask({ text: "y?", rule: "$x = 1", probe: measure({ x: 1 }) })).state).toBe("yes");
});

test("live pheromone ($hot) tracks look, NEEDS, probe_ref and ask, and evaporates without writing to Relate", async () => {
  await hub.idle();
  hub.close();
  hub = await Hub.open(root, { pollMs: 0, heatHalfLifeMs: 150 });
  const a = await hub.ask({
    text: "Save a file.",
    rule: "$ok",
    probe: `# /// script\n# dependencies = []\n# ///\nimport json, os\nopen(os.path.join(os.environ["WITNESS_OUT"], "f.txt"), "w").write("hi")\nprint("WITNESS_RESULT", json.dumps({"ok": True}))\n`,
  });
  const b = await hub.ask({
    text: "Read a's file.",
    rule: "$ok",
    inputs: [`${a.id}/f.txt`],
    probe: `# /// script\n# dependencies = []\n# ///\nimport json\nassert open("${a.id}/f.txt").read() == "hi"\nprint("WITNESS_RESULT", json.dumps({"ok": True}))\n`,
  });
  hub.look(`${a.id}/f.txt`);
  const hotNow = hub.query("RETURN $hot AS hot").rows[0]!.hot as string[];
  expect(hotNow[0]).toBe(a.id);
  expect(hotNow).toContain(b.id);
  // Wait several half-lives: heat evaporates completely and query itself deposits no heat.
  await Bun.sleep(700);
  expect(hub.query("RETURN $hot AS hot").rows[0]!.hot).toEqual([]);
  // Heat is never stored as a property in Relate.
  expect(hub.query("MATCH (q:Question) RETURN q.heat AS heat").rows.every((r) => r.heat === null)).toBe(true);
});

test("multi-record runs store r.last as the final measurement JSON, and unconsumed saved files query works", async () => {
  const a = await hub.ask({
    text: "Stream two records and save a file.",
    rule: "$done = true",
    probe: `# /// script\n# dependencies = []\n# ///\nimport json, os\nprint("WITNESS_RESULT", json.dumps({"shard": 0, "score": 1}))\nprint("WITNESS_RESULT", json.dumps({"shard": 1, "score": 2, "done": True}))\nopen(os.path.join(os.environ["WITNESS_OUT"], "cand.json"), "w").write("{}")\n`,
  });
  expect(a.state).toBe("yes");
  const row = hub.query("MATCH (r:Run {id: $run}) RETURN r.last AS last", { run: a.run! }).rows[0]!;
  expect(JSON.parse(String(row.last))).toEqual({ shard: 1, score: 2, done: true });

  const unconsumed = () =>
    hub.query(
      `MATCH (q:Question)<-[:OF]-(r:Run)-[s:SAVED]->(:File)
       WHERE r.id IN $current
         AND NOT EXISTS { MATCH (:Question)-[:NEEDS {name: q.id + '/' + s.name}]->(q) }
       RETURN q.id + '/' + s.name AS file`,
    ).rows.map((r) => r.file);
  expect(unconsumed()).toContain(`${a.id}/cand.json`);

  await hub.ask({
    text: "Consume cand.json.",
    rule: "$ok = true",
    inputs: [`${a.id}/cand.json`],
    probe: `# /// script\n# dependencies = []\n# ///\nimport json\nassert open("${a.id}/cand.json").read() == "{}"\nprint("WITNESS_RESULT", json.dumps({"ok": True}))\n`,
  });
  expect(unconsumed()).not.toContain(`${a.id}/cand.json`);
});

test("cancel() stops a running probe cleanly, keeps it at the top of $hot while running, and allows retry", async () => {
  const slow = await hub.ask({
    text: "Wait briefly unless cancelled.",
    rule: "$ok = true",
    waitS: 0,
    probe: `# /// script\n# dependencies = []\n# ///\nimport json, time\ntime.sleep(10)\nprint("WITNESS_RESULT", json.dumps({"ok": True}))\n`,
  });
  expect(slow.state).toBe("running");
  const hotWhileRunning = hub.query("RETURN $hot AS hot").rows[0]!.hot as string[];
  expect(hotWhileRunning[0]).toBe(slow.id);

  expect(hub.cancel(slow.id)).toBe(true);
  await hub.idle();
  const after = hub.status(slow.id);
  expect(after.state).toBe("failed");
  expect(after.reason).toContain("cancelled");
  // Cancelling a non-running question returns false.
  expect(hub.cancel(slow.id)).toBe(false);
});
