#!/usr/bin/env bun
// The witness command: setup, mcp (for agents), serve, status, stop.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { announce, bridge, running } from "./connect.ts";
import { Hub } from "./hub.ts";
import { serve } from "./server.ts";
import { setup } from "./setup.ts";
import { VERSION } from "./version.ts";

const USAGE = `witness ${VERSION}: tested answers for a team of agents, in a Relate graph.

Usage:
  witness setup            link the skill into Claude Code and add the MCP server to Claude Code and Codex
  witness mcp              MCP over stdio, for an agent. Starts the workspace's hub when none runs
  witness serve            run the hub in the foreground: the page, MCP over HTTP, the reruns
  witness status           where the workspace's hub serves
  witness stop             stop the workspace's hub

Options:
  --root DIR   the workspace (default: this folder). The store is DIR/.witness
  --port N     serve: the port (default 4747; 0 picks a free one)
  --host HOST  serve: the address to listen on (default 127.0.0.1)
  --jobs N     serve: how many probes may run at once (default 4)`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    root: { type: "string", default: "." },
    port: { type: "string", default: "4747" },
    host: { type: "string", default: "127.0.0.1" },
    jobs: { type: "string", default: "4" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  allowPositionals: true,
});
const root = resolve(values.root);

switch (values.version ? "version" : values.help ? "help" : positionals[0]) {
  case "version":
    console.log(VERSION);
    break;
  case "setup":
    setup();
    break;
  case "mcp":
    await bridge(root);
    break;
  case "serve": {
    const other = await running(root);
    if (other) {
      console.error(`A hub already serves ${root} at ${other.url.href} (process ${other.pid}).`);
      process.exit(1);
    }
    let hub: Hub;
    try {
      hub = await Hub.open(root, { jobs: Number(values.jobs) });
    } catch (e) {
      console.error(`Could not open ${root}/.witness/graph: ${(e as Error).message}\nAnother process may hold the store. Only one hub can serve a workspace.`);
      process.exit(1);
    }
    const server = serve(hub, { port: Number(values.port), hostname: values.host });
    announce(root, server.url);
    console.log(`Witness ${VERSION}: ${root}\n  page: ${server.url.href}\n  MCP:  ${new URL("/mcp", server.url).href}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, async () => {
        server.stop();
        await hub.idle();
        hub.close();
        process.exit(0);
      });
    break;
  }
  case "status": {
    const r = await running(root);
    console.log(r ? `The hub serves ${root} at ${r.url.href} (process ${r.pid}).` : `No hub serves ${root}.`);
    break;
  }
  case "stop": {
    const r = await running(root);
    if (r) process.kill(r.pid, "SIGTERM");
    console.log(r ? `Stopped the hub at ${r.url.href}.` : `No hub serves ${root}.`);
    break;
  }
  default:
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
}
