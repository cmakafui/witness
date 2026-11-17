// A hub lives while it is used and exits when it is not; an agent's bridge survives the hub going away.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hub, running } from "../src/connect.ts";
import { codexTimeout, piTimeout } from "../src/setup.ts";

const roots: string[] = [];
const workspace = () => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "witness-life-")));
  roots.push(r);
  return r;
};
afterAll(async () => {
  for (const r of roots) {
    const h = await running(r);
    if (h) process.kill(h.pid, "SIGTERM");
  }
  await Bun.sleep(300);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

test("a hub that nobody uses exits by itself and removes its record", async () => {
  const root = workspace();
  await hub(root, 2);
  expect(await running(root)).not.toBeNull();
  for (let i = 0; i < 40 && existsSync(join(root, ".witness", "hub.json")); i++) await Bun.sleep(250);
  expect(existsSync(join(root, ".witness", "hub.json"))).toBe(false);
  expect(await running(root)).toBeNull();
}, 30_000);

test("a hub with a page open does not exit", async () => {
  const root = workspace();
  const url = await hub(root, 2);
  const ws = new WebSocket(new URL("/events", url.href.replace(/^http/, "ws")));
  await new Promise((resolve) => (ws.onopen = resolve));
  await Bun.sleep(4000);
  expect(await running(root)).not.toBeNull();
  ws.close();
}, 30_000);

test("setup gives Codex's witness server a tool timeout once, and changes nothing else", () => {
  const config = `model = "x"\n\n[mcp_servers.witness]\ncommand = "bun"\nargs = ["main.ts", "mcp"]\n\n[mcp_servers.other]\ncommand = "o"\n`;
  const once = codexTimeout(config);
  expect(once).toBe(`model = "x"\n\n[mcp_servers.witness]\ntool_timeout_sec = 300\ncommand = "bun"\nargs = ["main.ts", "mcp"]\n\n[mcp_servers.other]\ncommand = "o"\n`);
  expect(codexTimeout(once)).toBe(once);
  expect(codexTimeout(`[mcp_servers.other]\ncommand = "o"\n`)).toBe(`[mcp_servers.other]\ncommand = "o"\n`);
});

test("setup gives Pi's witness server a timeout once, and changes nothing else", () => {
  const other = { command: "o", exposure: "direct", enabled: false };
  const config = JSON.stringify({ mcpServers: { other, witness: { command: "bun", args: ["main.ts", "mcp"], exposure: "direct" } } });
  const once = piTimeout(config);
  expect(JSON.parse(once)).toEqual({ mcpServers: { other, witness: { command: "bun", args: ["main.ts", "mcp"], exposure: "direct", timeout: 300 } } });
  expect(piTimeout(once)).toBe(once);
  const kept = JSON.stringify({ mcpServers: { witness: { command: "bun", timeout: 900 } } });
  expect(piTimeout(kept)).toBe(kept);
  expect(piTimeout(JSON.stringify({ mcpServers: { other } }))).toBe(JSON.stringify({ mcpServers: { other } }));
});
