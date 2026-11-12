#!/usr/bin/env bun
// witness serve: opens the hub for a workspace, and serves the web page and MCP for agents.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Hub } from "./hub.ts";
import { serve } from "./server.ts";
import { VERSION } from "./version.ts";

const USAGE = `witness ${VERSION}

Usage: witness serve [--root DIR] [--port N] [--host HOST] [--jobs N]

  --root DIR   the workspace (default: this folder). The store is DIR/.witness.
  --port N     the port for the page and for MCP (default 4747)
  --host HOST  the address to listen on (default 127.0.0.1)
  --jobs N     how many probes may run at once (default 4)`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    root: { type: "string", default: "." },
    port: { type: "string", default: "4747" },
    host: { type: "string", default: "127.0.0.1" },
    jobs: { type: "string", default: "4" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

if (values.help || positionals[0] !== "serve") {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const root = resolve(values.root);
const hub = await Hub.open(root, { jobs: Number(values.jobs) });
const server = serve(hub, { port: Number(values.port), hostname: values.host });
const mcpUrl = new URL("/mcp", server.url).href;
console.log(`Witness ${VERSION}: ${root}
  page:  ${server.url.href}
  MCP:   ${mcpUrl}
  add it to Claude Code:  claude mcp add --transport http witness ${mcpUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    server.stop();
    await hub.idle();
    hub.close();
    process.exit(0);
  });
