// Finds the hub of a workspace, or starts one. Every agent in a workspace shares one hub: the hub is the only process
// that can write the store, so if two start at once, Relate lets one win and the other exits.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const MAIN = join(import.meta.dir, "main.ts");
const info = (root: string) => join(root, ".witness", "hub.json");

/** The address of the hub that serves this workspace now, or null. */
export async function running(root: string): Promise<{ url: URL; pid: number } | null> {
  try {
    const { url, pid } = JSON.parse(readFileSync(info(root), "utf8"));
    const r = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1500) });
    if (r.ok && (await r.json()).root === root) return { url: new URL(url), pid };
  } catch {}
  return null;
}

/** Records where this process serves the workspace, and removes the record when it exits. */
export function announce(root: string, url: URL) {
  writeFileSync(info(root), JSON.stringify({ url: url.href, pid: process.pid }));
  process.on("exit", () => {
    try {
      if (JSON.parse(readFileSync(info(root), "utf8")).pid === process.pid) rmSync(info(root));
    } catch {}
  });
}

/** The hub of this workspace: the one that runs, or a new one in the background. Its output goes to .witness/hub.log. */
export async function hub(root: string): Promise<URL> {
  const found = await running(root);
  if (found) return found.url;
  mkdirSync(join(root, ".witness"), { recursive: true });
  const log = openSync(join(root, ".witness", "hub.log"), "a");
  spawn(process.execPath, [MAIN, "serve", "--root", root, "--port", "0"], { detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100);
    const up = await running(root);
    if (up) return up.url;
  }
  throw new Error(`The Witness hub did not start. See ${join(root, ".witness", "hub.log")}.`);
}

/** MCP over stdio for one agent: passes every message to the workspace's hub and back. */
export async function bridge(root: string) {
  const url = await hub(root);
  const local = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(new URL("/mcp", url));
  local.onmessage = (m) => void remote.send(m).catch((e) => console.error(`witness: ${(e as Error).message}`));
  remote.onmessage = (m) => void local.send(m);
  local.onclose = () => void remote.close();
  remote.onerror = (e) => console.error(`witness: ${e.message}`);
  await remote.start();
  await local.start();
}
