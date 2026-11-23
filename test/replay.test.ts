// A recorded store loads immediately; goals and evidence links open its committed answers.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { replay } from "../src/replay.ts";

let root: string;
const ids: Record<string, string> = {};
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-replay-"));
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const hub = await Hub.open(root, { pollMs: 0 });
  const complete = hub.goal("The data holds numbers.");
  const open = hub.goal("An acceptance contract is still to be chosen.");
  const incomplete = hub.goal("The saved total exceeds 100.");
  Object.assign(ids, { complete: complete.id, open: open.id, incomplete: incomplete.id });
  const head = "# /// script\n# dependencies = []\n# ///\nimport json, os\n";
  const inspect = {
    accepts: complete.id,
    text: "Does data.txt hold numbers?",
    rule: "$count >= 1",
    inputs: ["data.txt"],
    probe: `${head}n=[int(x) for x in open("data.txt").read().split()]\nassert n\njson.dump(n, open(os.path.join(os.environ["WITNESS_OUT"], "n.json"), "w"))\nprint("WITNESS_RESULT", json.dumps({"count": len(n)}))`,
  };
  const first = await hub.ask(inspect);
  writeFileSync(join(root, "data.txt"), "4 5 6 0");
  const a = await hub.ask(inspect);
  Object.assign(ids, { oldRun: first.run, latestRun: a.run });
  const b = await hub.ask({
    text: "Is the total above 100?",
    rule: "$total > 100",
    inputs: [`${a.id}/n.json`],
    probe: `${head}n=json.load(open("${a.id}/n.json"))\njson.dump(n, open(os.path.join(os.environ["WITNESS_OUT"], "n.json"), "w"))\nprint("WITNESS_RESULT", json.dumps({"total": sum(n)}))`,
  });
  const c = await hub.ask({ text: "Does it crash?", rule: "$x = 1", probe: `${head}raise SystemExit(2)\nprint("WITNESS_RESULT", "{}")` });
  const d = await hub.ask({ accepts: incomplete.id, text: "Is the saved total above 100?", rule: "$total > 100", inputs: [`${b.id}/n.json`], probe: `${head}n=json.load(open("${b.id}/n.json"))\nprint("WITNESS_RESULT", json.dumps({"total": sum(n)}))` });
  Object.assign(ids, { a: a.id, b: b.id, c: c.id, d: d.id });
  await hub.idle();
  hub.close();
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("replay searches the recorded store by words", async () => {
  const server = replay(root, { port: 0 });
  const client = new Client({ name: "replay-reader", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", server.url)));
    const q = await client.callTool({ name: "query", arguments: { cypher: "MATCH (q:Question) SEARCH q IN (FULLTEXT INDEX question_text FOR 'crash' LIMIT 5) SCORE AS s RETURN q.id AS id" } });
    expect(q.structuredContent).toEqual({ rows: [{ id: ids.c }], truncated: false });
  } finally {
    await client.close();
    server.stop(true);
  }
});

test("a viewer receives the whole recorded graph and answers immediately, without running changed inputs", async () => {
  writeFileSync(join(root, "data.txt"), "");
  const server = replay(root, { port: 0 });
  const ws = new WebSocket(new URL("/events", server.url.href.replace(/^http/, "ws")));
  try {
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("recorded snapshot did not arrive")), 5000);
      ws.onerror = () => { clearTimeout(timeout); reject(new Error("recorded connection failed")); };
      ws.onmessage = (e) => {
        messages.push(JSON.parse(String(e.data)));
        if (messages.length === 2) { clearTimeout(timeout); resolve(); }
      };
    });
    expect(messages.map((m) => m.type)).toEqual(["graph", "states"]);
    expect(messages[0].nodes.filter((n: any) => n.label === "Question")).toHaveLength(4);
    expect(messages[0].nodes.filter((n: any) => n.label === "Run")).toHaveLength(5);
    expect(Object.fromEntries(messages[1].states.map((s: any) => [s.id, s.state])))
      .toEqual({ [ids.a!]: "yes", [ids.b!]: "no", [ids.c!]: "failed", [ids.d!]: "no" });
    expect(messages[1].states.find((s: any) => s.id === ids.a).run).toBe(ids.latestRun);
    expect(messages[0].nodes.some((n: any) => n.id === ids.oldRun)).toBe(true);
    const run = ids.latestRun;
    const file = messages[0].rels.find((r: any) => r.type === "SAVED" && r.from === run).to;
    const output = await fetch(new URL(`/files/${file}?name=n.json`, server.url));
    expect(await output.json()).toEqual([4, 5, 6, 0]);
  } finally {
    ws.close();
    server.stop(true);
  }
});

test("replay exposes read-only /mcp with query and look only", async () => {
  const server = replay(root, { port: 0 });
  const client = new Client({ name: "replay-reader", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", server.url)));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["look", "query"]);
    const q = await client.callTool({ name: "query", arguments: { cypher: "RETURN $complete AS complete, $yes AS yes, $no AS no" } });
    expect(q.structuredContent).toEqual({ rows: [{ complete: [ids.complete], yes: [ids.a], no: [ids.b, ids.d] }], truncated: false });
    const l = await client.callTool({ name: "look", arguments: { file: `${ids.a}/n.json` } });
    expect(JSON.parse((l.structuredContent as { text: string }).text)).toEqual([4, 5, 6, 0]);
    // The recorded store is searchable, and still read-only.
    const found = await client.callTool({ name: "query", arguments: { cypher: "MATCH (q:Question) SEARCH q IN (FULLTEXT INDEX question_text FOR 'total' LIMIT 5) SCORE AS s RETURN q.id AS id ORDER BY id" } });
    expect(found.structuredContent).toEqual({ rows: [ids.b, ids.d].sort().map((id) => ({ id })), truncated: false });
    const write = await client.callTool({ name: "query", arguments: { cypher: "CREATE (:Goal {id: 'g-x', text: 'x', seq: 99})" } });
    expect(write.isError).toBe(true);
    const forbidden = await fetch(new URL("/mcp", server.url), { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    expect(forbidden.status).toBe(403);
  } finally {
    await client.close();
    server.stop(true);
  }
});

test("the recorded page supports goal and evidence navigation and WebMCP", async () => {
  const server = replay(root, { port: 0 });
  try {
    await using view = new Bun.WebView({ width: 1000, height: 700 });
    await view.navigate(server.url.href);
    let got = "";
    for (let i = 0; i < 100 && got !== "no"; i++) {
      await Bun.sleep(100);
      got = (await view.evaluate(`window.witness ? window.witness.state(${JSON.stringify(ids.b)}) : null`).catch(() => null)) as string;
    }
    expect(got).toBe("no");

    // The page's WebMCP tools: they read the page's copy, show the person what they found, and refuse to write.
    // A refusal is a reply the agent can read and fix, as on /mcp.
    const call = (name: string, args: object) =>
      view.evaluate(`window.witness.tools.find((t) => t.name === ${JSON.stringify(name)}).execute(${JSON.stringify(args)}).then(JSON.parse)`);
    expect(await view.evaluate("window.witness.tools.map((t) => [t.name, t.annotations.readOnlyHint, t.annotations.untrustedContentHint])")).toEqual([
      ["query", true, true],
      ["show_question", true, true],
    ]);
    const choose = (id: string) => view.evaluate(`(() => { document.getElementById('goal').value = ${JSON.stringify(id)}; document.getElementById('goal').dispatchEvent(new Event('change')); })()`);
    expect(await view.evaluate("document.getElementById('goal').value")).toBe(ids.complete);
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does data.txt hold numbers?");
    // Acceptance questions carry the ringed acceptance mark; hovering previews a question in the top bar without replacing Evidence.
    expect(await view.evaluate("[...document.querySelectorAll('.q.accepts')].map(q => q.dataset.id).sort()")).toEqual([ids.a, ids.d].sort());
    await view.evaluate(`document.querySelector('[data-id="${ids.b}"]').dispatchEvent(new PointerEvent('pointerenter'))`);
    expect(await view.evaluate("document.getElementById('hover-bar').textContent")).toContain("Is the total above 100?");
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does data.txt hold numbers?");
    await choose(ids.open!);
    expect(await view.evaluate("document.getElementById('question').textContent")).toContain("No acceptance question.");
    await choose("");
    expect(await call("query", { cypher: "MATCH (g:Goal) OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question) RETURN g.id AS id, g.id IN $complete AS complete, q.id AS acceptance ORDER BY g.seq" }))
      .toMatchObject({ rows: [{ id: ids.complete, complete: true, acceptance: ids.a }, { id: ids.open, complete: false, acceptance: null }, { id: ids.incomplete, complete: false, acceptance: ids.d }] });
    const yes = "MATCH (q:Question) WHERE q.id IN $yes RETURN q.id AS id";
    expect(await call("query", { cypher: yes })).toEqual({ columns: ["id"], rows: [{ id: ids.a }], truncated: false });
    // The docked Query drawer opens on the left while Evidence remains visible on the right.
    expect(await view.evaluate("[document.getElementById('cypher').value, document.getElementById('query').hidden, document.getElementById('question').hidden]")).toEqual([yes, false, false]);

    // The page's copy has the search indexes.
    expect(await call("query", { cypher: "MATCH (q:Question) SEARCH q IN (FULLTEXT INDEX question_text FOR 'crash' LIMIT 5) SCORE AS s RETURN q.id AS id" }))
      .toMatchObject({ rows: [{ id: ids.c }] });
    // A query runs on a throwaway copy: a query that writes changes nothing the page shows, from the tool or the drawer.
    for (const cypher of ["MATCH (q:Question) SET q.text = 'forged'", "CREATE (:Question {id: 'q-000000000000', text: 'forged'})", "MATCH (q:Question) CALL { CREATE (:Run) } RETURN count(q) AS n"])
      await call("query", { cypher });
    await view.evaluate("document.getElementById('run').click()");
    expect(await view.evaluate("document.querySelectorAll('.q').length === window.witness.questions()")).toBe(true);
    const forged = "MATCH (n) WHERE n.text = 'forged' OR n.id = 'q-000000000000' OR (n:Run AND n.id IS NULL) RETURN count(n) AS n";
    expect(await view.evaluate(`window.witness.cypher(${JSON.stringify(forged)})`)).toEqual([{ n: 0 }]);

    const shown = (await call("show_question", { id: ids.b })) as Record<string, unknown>;
    expect(shown).toMatchObject({ id: ids.b, answer: "no", restsOn: [ids.a] });
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the total above 100?");
    expect(await call("show_question", { id: "q-ffffffffffff" })).toEqual({ refused: `There is no question q-ffffffffffff. Call query to list the questions.` });

    // Follow actual dependency chips through two questions, then return to the
    // original reading position and expanded probe. Re-selecting adds no history.
    expect(await view.evaluate("document.getElementById('evidence-back').hidden")).toBe(true);
    await call("show_question", { id: ids.b });
    expect(await view.evaluate("document.getElementById('evidence-back').hidden")).toBe(true);
    await call("show_question", { id: ids.d });
    const readingPosition = await view.evaluate(`(() => {
      document.querySelector('#question details.probe').open = true;
      document.querySelector('#question details.runs-disclosure').open = true;
      const panel = document.getElementById('question'); panel.scrollTop = 120;
      return panel.scrollTop;
    })()`);
    expect(readingPosition as number).toBeGreaterThan(0);
    await view.evaluate("document.querySelector('#question button.chip').click()");
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the total above 100?");
    await view.evaluate("document.querySelector('#question button.chip').click()");
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does data.txt hold numbers?");
    await view.evaluate("document.getElementById('evidence-back').click()");
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the total above 100?");
    await view.evaluate("document.getElementById('evidence-back').click()");
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the saved total above 100?");
    expect(await view.evaluate("document.querySelector('#question details.probe').open")).toBe(true);
    expect(await view.evaluate("document.getElementById('question').scrollTop")).toBe(readingPosition);
    await view.evaluate("document.getElementById('evidence-back').click()");
    expect(await view.evaluate("document.getElementById('evidence-back').hidden")).toBe(true);
    expect(await view.evaluate("document.activeElement === document.querySelector('#question h2')")).toBe(true);

    await choose(ids.complete!);
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does data.txt hold numbers?");
    expect(await call("show_question", { id: ids.b })).toMatchObject({ accepts: [] });
    expect(await view.evaluate("document.querySelector('#question .clause .values').textContent")).toContain("total15");
    expect(await view.evaluate("document.querySelector('#question .measurements')")).toBeNull();
    expect(await view.evaluate("[...document.querySelectorAll('.q')].map(q => q.dataset.id)")).toContain(ids.c);
    const inputUrl = await view.evaluate("document.querySelector('#question .files a').href") as string;
    expect(await (await fetch(inputUrl)).json()).toEqual([4, 5, 6, 0]);

    // Every entry point derives the same upstream highlight from the selected question.
    const lit = () => view.evaluate("[...document.querySelectorAll('.q:not(.dim)')].map(q => q.dataset.id)");
    expect(await lit()).toEqual([ids.a, ids.b]);
    expect(await view.evaluate("document.querySelectorAll('.link.lit').length")).toBe(1);
    const openWidths = await view.evaluate("[document.getElementById('graph').clientWidth, document.getElementById('sidebar').getBoundingClientRect().width]");
    await call("show_question", { id: ids.d });
    expect(await lit()).toEqual([ids.a, ids.b, ids.d]);
    expect(await view.evaluate("document.querySelectorAll('.link.lit').length")).toBe(2);
    expect(await view.evaluate("[document.getElementById('graph').clientWidth, document.getElementById('sidebar').getBoundingClientRect().width]")).toEqual(openWidths);
    await view.evaluate("document.querySelector('#question button.chip').click()");
    expect(await lit()).toEqual([ids.a, ids.b]);
    await view.evaluate("document.getElementById('evidence-back').click()");
    expect(await lit()).toEqual([ids.a, ids.b, ids.d]);

    // Browser-agent selection opens the evidence panel with the same derived highlight.
    const lanesWidth = await view.evaluate("document.getElementById('graph').clientWidth");
    await view.evaluate("document.getElementById('sidebar-toggle').click()");
    await call("show_question", { id: ids.b });
    expect(await lit()).toEqual([ids.a, ids.b]);
    expect(await view.evaluate("[document.getElementById('graph').clientWidth, document.getElementById('sidebar').getBoundingClientRect().width]")).toEqual([lanesWidth, 440]);
    expect(await view.evaluate("document.getElementById('sidebar-toggle').getAttribute('aria-expanded')")).toBe("true");
    await choose("");
    expect(await lit()).toHaveLength(4);
    expect(await view.evaluate("document.querySelectorAll('.link.lit').length")).toBe(0);

    // Goal selection and graph selections open evidence directly, including no and failed answers.
    await choose(ids.incomplete!);
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the saved total above 100?");
    expect(await view.evaluate("document.querySelector('#question .badge').textContent")).toBe("no");
    await view.evaluate(`document.querySelector('[data-id="${ids.c}"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does it crash?");
    expect(await view.evaluate("document.querySelector('#question .badge').textContent")).toBe("failed");
    expect(await lit()).toEqual([ids.c]);
    await view.evaluate("document.getElementById('evidence-back').click()");
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the saved total above 100?");

    // The seq slider steps through recorded history: earlier runs, pending states, hidden future questions, and queries at that seq.
    expect(await view.evaluate("[document.getElementById('seq-bar').hidden, document.getElementById('seq').max, document.getElementById('seq-value').textContent]"))
      .toEqual([false, "12", "seq 12"]);
    await choose(ids.complete!);
    expect(await view.evaluate("document.querySelector('#question details.runs-disclosure summary').textContent")).toBe("2 runs");
    // At seq 4, question a was asked but its first run (seq 5) had not finished yet.
    await view.evaluate("(() => { const s = document.getElementById('seq'); s.value = '4'; s.dispatchEvent(new Event('input')); })()");
    expect(await view.evaluate("[document.getElementById('seq-value').textContent, window.witness.state(" + JSON.stringify(ids.a) + "), document.querySelector('#question .badge').textContent, document.querySelector('#question .clause .mark').textContent]"))
      .toEqual(["seq 4 / 12", "pending", "pending", "not run yet"]);
    expect(await view.evaluate("[...document.querySelectorAll('.q')].filter(q => q.getAttribute('display') !== 'none').map(q => q.dataset.id)")).toEqual([ids.a]);
    // At seq 5, the first run finished (oldRun); the run on changed data at seq 6 has not happened yet.
    await view.evaluate("window.witness.setSeq(5)");
    expect(await view.evaluate("[window.witness.state(" + JSON.stringify(ids.a) + "), document.querySelector('#question details.runs-disclosure summary').textContent]"))
      .toEqual(["yes", "1 run"]);
    expect(await call("query", { cypher: "MATCH (r:Run) WHERE r.id IN $current RETURN r.id AS run" }))
      .toEqual({ columns: ["run"], rows: [{ run: ids.oldRun }], truncated: false });
    // Dragging back to maxSeq restores the latest run and all questions.
    await view.evaluate("window.witness.setSeq(null)");
    expect(await view.evaluate("[document.getElementById('seq-value').textContent, document.querySelector('#question details.runs-disclosure summary').textContent]"))
      .toEqual(["seq 12", "2 runs"]);
    expect(await call("query", { cypher: "MATCH (r:Run) WHERE r.id IN $current AND r.id = '" + ids.latestRun + "' RETURN r.id AS run" }))
      .toEqual({ columns: ["run"], rows: [{ run: ids.latestRun }], truncated: false });
  } finally {
    server.stop(true);
  }
}, 30_000);
