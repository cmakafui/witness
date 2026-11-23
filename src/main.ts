#!/usr/bin/env bun
// The witness command. People use setup, open and replay. MCP clients use mcp; mcp starts serve in the background.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { announce, bridge, hub as findHub, running } from "./connect.ts";
import { Hub } from "./hub.ts";
import { replay } from "./replay.ts";
import { serve } from "./server.ts";
import { setup } from "./setup.ts";
import { VERSION } from "./version.ts";

const USAGE = `witness ${VERSION}: tested answers for a team of agents, in a Relate graph.

  witness setup              once: link the skill into Claude Code, add the MCP server to Claude Code, Codex, Pi and agy
  witness open [DIR]         open the workspace's graph in the browser (starts its hub when none runs)
  witness replay [DIR]       inspect a recorded session in the browser, from its store alone
  witness cancel Q-ID [DIR]  cancel a running probe (SIGTERM, then SIGKILL after 3 s)

DIR is the workspace (default: this folder). Its store is DIR/.witness.
A hub exits by itself after ${600 / 60} minutes without use.

Plumbing: \`witness mcp\` is the command MCP clients run (setup adds it). \`witness serve\` runs a hub in the
foreground (--port N, --host HOST, --jobs N, --idle SECONDS, 0 = never exit). --jobs is how many probes run at
once: by default WITNESS_JOBS, else one per CPU core. A hub that an agent starts gets WITNESS_JOBS from the agent's
environment.`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    root: { type: "string" },
    port: { type: "string" },
    host: { type: "string", default: "127.0.0.1" },
    jobs: { type: "string" },
    idle: { type: "string", default: "0" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  allowPositionals: true,
});
const [command, arg1, arg2] = positionals;
const dir = command === "cancel" ? arg2 : arg1;
const root = resolve(values.root ?? dir ?? ".");

/** Opens a page in the default browser. */
function browse(url: URL) {
  const cmd = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  Bun.spawn([...cmd, url.href], { stdout: "ignore", stderr: "ignore" });
}

switch (values.version ? "version" : values.help ? "help" : command) {
  case "version":
    console.log(VERSION);
    break;
  case "setup":
    setup();
    break;
  case "open": {
    const url = await findHub(root);
    console.log(`Witness: ${root}\n  page: ${url.href}`);
    browse(url);
    break;
  }
  case "replay": {
    const server = replay(root, { port: Number(values.port ?? 4748), hostname: values.host });
    console.log(`Witness replay of ${root}\n  page: ${server.url.href}\n  choose a goal or a graph question to inspect its rule and measurements`);
    browse(server.url);
    break;
  }
  case "cancel": {
    if (!arg1) {
      console.error("Usage: witness cancel <q-id> [DIR]");
      process.exit(2);
    }
    const up = await running(root);
    if (!up) {
      console.error(`No hub is running for ${root}.`);
      process.exit(1);
    }
    const res = await fetch(new URL(`/cancel/${encodeURIComponent(arg1)}`, up.url), { method: "POST" });
    const body = (await res.json()) as { cancelled?: boolean; error?: string };
    if (!res.ok) {
      console.error(body.error ?? `Failed (${res.status}).`);
      process.exit(1);
    }
    console.log(body.cancelled ? `Cancelled ${arg1}.` : `${arg1} is not running.`);
    break;
  }
  case "mcp":
    await bridge(root);
    break;
  case "serve": {
    const other = await running(root);
    if (other) {
      console.error(`A hub already serves ${root} at ${other.url.href} (process ${other.pid}).`);
      process.exit(1);
    }
    const jobs = values.jobs ?? process.env.WITNESS_JOBS;
    if (jobs !== undefined && !/^[1-9]\d*$/.test(jobs)) {
      console.error(`--jobs (or WITNESS_JOBS) must be a whole number of at least 1, not ${JSON.stringify(jobs)}.`);
      process.exit(2);
    }
    let hub: Hub;
    try {
      hub = await Hub.open(root, jobs === undefined ? {} : { jobs: Number(jobs) });
    } catch (e) {
      console.error(`Could not open ${root}/.witness/graph: ${(e as Error).message}\nAnother process may hold the store. Only one hub can serve a workspace.`);
      process.exit(1);
    }
    const server = serve(hub, { port: Number(values.port ?? 4747), hostname: values.host });
    announce(root, server.url);
    console.log(`Witness ${VERSION}: ${root}\n  page: ${server.url.href}\n  MCP:  ${new URL("/mcp", server.url).href}`);
    const stop = async () => {
      server.stop();
      await hub.idle();
      hub.close();
      process.exit(0);
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
    // Exit when nobody has used the hub for --idle seconds: no request, no open page, no probe running.
    const idleS = Number(values.idle);
    if (idleS > 0)
      setInterval(
        () => {
          const quiet = Date.now() - server.activity.last > idleS * 1000;
          if (quiet && server.activity.pages === 0 && !hub.busy()) {
            console.log(`No use for ${idleS} s: stopping.`);
            void stop();
          }
        },
        Math.min(30_000, (idleS * 1000) / 4),
      );
    break;
  }
  default:
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
}
