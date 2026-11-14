// The whole path: an agent asks over MCP, the hub runs the probe, and the page shows it live, from its own copy of the graph.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { serve } from "../src/server.ts";

let root: string;
let hub: Hub;
let server: ReturnType<typeof serve>;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-server-"));
  writeFileSync(join(root, "data.txt"), "4 5 6");
  hub = await Hub.open(root, { pollMs: 200 });
  server = serve(hub, { port: 0 });
});
afterAll(async () => {
  await hub.idle();
  server.stop(true);
  hub.close();
  rmSync(root, { recursive: true, force: true });
});

const PROBE = `# /// script
# dependencies = []
# ///
import json, os
nums = [int(x) for x in open("data.txt").read().split()]
assert nums
print("WITNESS_RESULT", json.dumps({"total": sum(nums)}))
json.dump({"total": sum(nums)}, open(os.path.join(os.environ["WITNESS_OUT"], "total.json"), "w"))
`;

async function agent() {
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", server.url)));
  return client;
}
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);

test("an agent asks over MCP, queries the graph, and gets a refusal it can fix", async () => {
  const client = await agent();
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["ask", "goal", "look", "query"]);
  const g = json(await client.callTool({ name: "goal", arguments: { text: "The total of data.txt exceeds 10." } }));
  expect(g).toMatchObject({ state: "open", complete: false });
  const a = json(await client.callTool({ name: "ask", arguments: { accepts: g.id, text: "Is the total of data.txt more than 10?", rule: "$total > 10", probe: PROBE, inputs: ["data.txt"], asker: "tester" } }));
  expect(a).toMatchObject({ state: "yes", results: [{ total: 15 }], goal: { id: g.id, complete: true, acceptance: a.id } });
  const q = json(await client.callTool({ name: "query", arguments: { cypher: "MATCH (q:Question) WHERE q.id IN $yes RETURN q.asker AS asker" } }));
  expect(q.rows).toEqual([{ asker: "tester" }]);
  expect(json(await client.callTool({ name: "query", arguments: { cypher: "RETURN $complete AS ids" } })).rows).toEqual([{ ids: [g.id] }]);
  const refused = await client.callTool({ name: "ask", arguments: { text: "x?", rule: "r", probe: "print(1)" } });
  expect(refused.isError).toBe(true);
  await client.close();
}, 60_000);

test("ask waits over HTTP for a probe that takes longer than Bun's default idle limit", async () => {
  const client = await agent();
  const slow = PROBE.replace("import json, os", "import json, os, time\ntime.sleep(12)");
  const a = json(await client.callTool({ name: "ask", arguments: { text: "After 12 seconds, is the total above 11?", rule: "$total > 11", probe: slow, inputs: ["data.txt"] } }));
  expect(a.state).toBe("yes");
  await client.close();
}, 60_000);

test("a request from another site's page is refused", async () => {
  const r = await fetch(new URL("/mcp", server.url), { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
  expect(r.status).toBe(403);
});

test("the page shows a new question and its answer live, from its own Relate copy", async () => {
  await using view = new Bun.WebView({ width: 1000, height: 700 });
  await view.navigate(server.url.href);
  const read = <T,>(js: string) => view.evaluate(js) as Promise<T>;
  const until = async (js: string, want: unknown) => {
    for (let i = 0; i < 100; i++) {
      const got = await read(js).catch(() => undefined);
      if (JSON.stringify(got) === JSON.stringify(want)) return;
      await Bun.sleep(100);
    }
    throw new Error(`page never showed ${JSON.stringify(want)} for ${js}`);
  };
  await until("typeof window.witness", "object");
  const client = await agent();
  const a = json(await client.callTool({ name: "ask", arguments: { text: "Is the total at most 100?", rule: "$total <= 100", probe: PROBE, inputs: ["data.txt"] } }));
  await until(`window.witness.state(${JSON.stringify(a.id)})`, "yes");
  await until(`window.witness.cypher("MATCH (:Run)-[:OF]->(q:Question {id: '${a.id}'}) RETURN count(*) AS n")[0].n`, 1);

  // Unrelated work must not replace a reader's open evidence or its expanded probe.
  await read(`(() => {
    window.witness.select(${JSON.stringify(a.id)});
    window.keptProbe = document.querySelector('#question details');
    window.keptProbe.open = true;
    window.keptPanel = document.querySelector('#question h2');
  })()`);
  const unrelated = json(await client.callTool({ name: "ask", arguments: {
    text: "Does unrelated work measure a total above 20?", rule: "$total > 20", probe: PROBE, inputs: ["data.txt"],
  } }));
  await until(`window.witness.state(${JSON.stringify(unrelated.id)})`, "no");
  await read("new Promise(requestAnimationFrame)");
  expect(await read("window.keptProbe === document.querySelector('#question details') && window.keptProbe.open && window.keptPanel === document.querySelector('#question h2')")).toBe(true);

  // A burst can rebuild the lane SVG at most once per frame.
  await read(`(() => {
    window.displayFrame = 0; window.svgUpdates = {}; window.sampleDisplay = true;
    const tick = () => { window.displayFrame++; if (window.sampleDisplay) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.svgObserver = new MutationObserver(records => {
      window.svgUpdates[window.displayFrame] = (window.svgUpdates[window.displayFrame] || 0) + records.length;
    });
    window.svgObserver.observe(document.querySelector('.lanes svg'), {childList:true});
  })()`);
  for (let i = 0; i < 32; i++) server.publish("feed", JSON.stringify({ type: "graph", nodes: [], rels: [] }));
  await until("Object.keys(window.svgUpdates).length > 0", true);
  await read("new Promise(requestAnimationFrame)");
  expect(await read("Math.max(...Object.values(window.svgUpdates))")).toBe(1);
  expect(await read("window.keptProbe === document.querySelector('#question details')")).toBe(true);
  await read("(() => { window.sampleDisplay = false; window.svgObserver.disconnect(); })()");

  // Linked work changes the selected panel even though its own answer is unchanged.
  const consumer = json(await client.callTool({ name: "ask", arguments: {
    text: "Is the saved total above 10?", rule: "$total > 10",
    probe: `# /// script\n# dependencies = []\n# ///\nimport json\ntotal = json.load(open("${a.id}/total.json"))["total"]\nprint("WITNESS_RESULT", json.dumps({"total": total}))`,
    inputs: [`${a.id}/total.json`],
  } }));
  await until(`window.witness.state(${JSON.stringify(consumer.id)})`, "yes");
  await until("[...document.querySelectorAll('#question button.chip')].some(b => b.textContent.includes('Is the saved total above 10?'))", true);
  expect(await read("window.keptPanel === document.querySelector('#question h2')")).toBe(false);
  expect(await read("document.querySelector('#question h2').textContent")).toBe("Is the total at most 100?");
  await client.close();
}, 60_000);

test("live goal rows follow acceptance invalidation and restoration, while exploration is only context", async () => {
  await using view = new Bun.WebView({ width: 1000, height: 700 });
  await view.navigate(server.url.href);
  const until = async (js: string, want: unknown) => {
    for (let i = 0; i < 100; i++) {
      const got = await view.evaluate(js).catch(() => undefined);
      if (JSON.stringify(got) === JSON.stringify(want)) return;
      await Bun.sleep(50);
    }
    expect(await view.evaluate(js)).toEqual(want);
  };
  await until("typeof window.witness", "object");
  const g = hub.goal("The live candidate is positive.");
  const row = `document.querySelector('[data-goal="${g.id}"]')`;
  await until(`${row}?.textContent.includes('No acceptance question')`, true);
  writeFileSync(join(root, "live-candidate.txt"), "1");
  const probe = `# /// script\n# dependencies = []\n# ///\nimport json, time\ntime.sleep(0.2)\nx = int(open('live-candidate.txt').read())\nprint('WITNESS_RESULT', json.dumps({'x': x}))`;
  const a = await hub.ask({ text: "Is the live candidate positive?", rule: "$x > 0", probe, inputs: ["live-candidate.txt"], accepts: g.id });
  await until(`${row}?.querySelector('.goal-completion').textContent`, "Complete");
  await view.evaluate(`${row}.querySelector('button').click()`);
  expect(await view.evaluate("document.querySelector('#question .goal-context').textContent")).toContain("Acceptance forThe live candidate is positive.");
  await hub.ask({ text: "Is this candidate below zero?", rule: "$x < 0", probe, inputs: ["live-candidate.txt"], goal: g.id });
  await until(`${row}?.querySelector('.goal-completion').textContent`, "Complete");
  // The browser query tool derives the same completion as the worker's query tool.
  const query = `MATCH (g:Goal {id: '${g.id}'}) RETURN g.id IN $complete AS complete`;
  const run = () => view.evaluate(`window.witness.tools.find(t => t.name === 'query').execute({cypher: ${JSON.stringify(query)}}).then(JSON.parse)`);
  expect(await run()).toMatchObject({ rows: [{ complete: true }] });
  writeFileSync(join(root, "live-candidate.txt"), "-2");
  hub.check();
  await until(`${row}?.querySelector('.goal-completion').textContent`, "Incomplete");
  await hub.idle();
  await until(`window.witness.state('${a.id}')`, "no");
  expect(await run()).toMatchObject({ rows: [{ complete: false }] });
  writeFileSync(join(root, "live-candidate.txt"), "1");
  hub.check();
  await until(`${row}?.querySelector('.goal-completion').textContent`, "Complete");
  expect(await run()).toMatchObject({ rows: [{ complete: true }] });
}, 30_000);
