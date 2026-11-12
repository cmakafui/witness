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
print("WITNESS_ANSWER", "yes" if sum(nums) > 10 else "no")
`;

async function agent() {
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", server.url)));
  return client;
}
const json = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);

test("an agent asks over MCP, queries the graph, and gets a refusal it can fix", async () => {
  const client = await agent();
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["ask", "look", "query"]);
  const a = json(await client.callTool({ name: "ask", arguments: { text: "Is the total of data.txt more than 10?", rule: "sum > 10", probe: PROBE, inputs: ["data.txt"], asker: "tester" } }));
  expect(a).toMatchObject({ state: "yes", results: [{ total: 15 }] });
  const q = json(await client.callTool({ name: "query", arguments: { cypher: "MATCH (q:Question) WHERE q.id IN $yes RETURN q.asker AS asker" } }));
  expect(q.rows).toEqual([{ asker: "tester" }]);
  const refused = await client.callTool({ name: "ask", arguments: { text: "x?", rule: "r", probe: "print(1)" } });
  expect(refused.isError).toBe(true);
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
  const a = json(await client.callTool({ name: "ask", arguments: { text: "Is the total at most 100?", rule: "sum <= 100", probe: PROBE.replace("sum(nums) > 10", "sum(nums) <= 100"), inputs: ["data.txt"] } }));
  await until(`window.witness.state(${JSON.stringify(a.id)})`, "yes");
  await until(`window.witness.cypher("MATCH (:Run)-[:ANSWERS]->(q:Question {id: '${a.id}'}) RETURN count(*) AS n")[0].n`, 1);
  await client.close();
}, 60_000);
