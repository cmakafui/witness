// Two agents start `witness mcp` in one workspace: the first starts the hub, the second finds it, and both share it.
import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIN, running } from "../src/connect.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "witness-connect-")));
writeFileSync(join(root, "data.txt"), "1 2 3");
afterAll(async () => {
  const hub = await running(root);
  if (hub) process.kill(hub.pid, "SIGTERM");
  await Bun.sleep(300);
  rmSync(root, { recursive: true, force: true });
});

async function agent(name: string) {
  const client = new Client({ name, version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MAIN, "mcp", "--root", root] }));
  return client;
}

test("agents in one workspace share one hub that `witness mcp` starts", async () => {
  const a = await agent("a");
  const hub = await running(root);
  expect(hub).not.toBeNull();

  const asked = await a.callTool({
    name: "ask",
    arguments: {
      text: "Does data.txt hold three numbers?",
      rule: "yes when exactly three integers parse",
      probe: `# /// script\n# dependencies = []\n# ///\nn = len(open("data.txt").read().split())\nassert n\nprint("WITNESS_ANSWER", "yes" if n == 3 else "no")`,
      inputs: ["data.txt"],
    },
  });
  expect(JSON.parse((asked.content as { text: string }[])[0]!.text).state).toBe("yes");

  const b = await agent("b");
  expect((await running(root))?.pid).toBe(hub!.pid);
  const seen = await b.callTool({ name: "query", arguments: { cypher: "MATCH (q:Question) WHERE q.id IN $yes RETURN count(q) AS n" } });
  expect(JSON.parse((seen.content as { text: string }[])[0]!.text).rows).toEqual([{ n: 1 }]);
  await a.close();
  await b.close();
}, 60_000);
