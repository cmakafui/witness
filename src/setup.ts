// witness setup: links the skill into Claude Code and registers the MCP server with Claude Code and Codex.
// MCP clients start servers without the user's shell profile, so the command names Bun and Witness by full path.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAIN } from "./connect.ts";

const SKILL = join(import.meta.dir, "..", "skill", "witness");
/** ask waits up to 240 s for an answer. Codex gives up on a tool call sooner unless its server says otherwise. */
const CODEX_TIMEOUT_S = 300;

/** Adds tool_timeout_sec to Codex's [mcp_servers.witness] section when the section has none. Changes nothing else. */
export function codexTimeout(config: string): string {
  const lines = config.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.witness]");
  if (start < 0) return config;
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith("["));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  if (section.some((l) => /^\s*tool_timeout_sec\s*=/.test(l))) return config;
  lines.splice(start + 1, 0, `tool_timeout_sec = ${CODEX_TIMEOUT_S}`);
  return lines.join("\n");
}

export function setup() {
  const command = [process.execPath, MAIN, "mcp"];
  const done: string[] = [];

  const target = join(homedir(), ".claude", "skills", "witness");
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) done.push(`skill: left ${target} as it is (it is not a link to Witness)`);
  else {
    rmSync(target, { force: true });
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(SKILL, target);
    done.push(`skill: ${target} -> ${SKILL}`);
  }

  if (Bun.which("claude")) {
    Bun.spawnSync(["claude", "mcp", "remove", "--scope", "user", "witness"], { stdout: "ignore", stderr: "ignore" });
    const r = Bun.spawnSync(["claude", "mcp", "add", "--scope", "user", "witness", "--", ...command], { stderr: "pipe" });
    done.push(r.exitCode === 0 ? "Claude Code: added the witness MCP server" : `Claude Code: could not add the server: ${r.stderr.toString().trim()}`);
  }
  if (Bun.which("codex")) {
    Bun.spawnSync(["codex", "mcp", "remove", "witness"], { stdout: "ignore", stderr: "ignore" });
    const r = Bun.spawnSync(["codex", "mcp", "add", "witness", "--", ...command], { stderr: "pipe" });
    const config = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
    if (r.exitCode === 0 && existsSync(config)) writeFileSync(config, codexTimeout(readFileSync(config, "utf8")));
    done.push(r.exitCode === 0 ? `Codex: added the witness MCP server, with tool_timeout_sec = ${CODEX_TIMEOUT_S}` : `Codex: could not add the server: ${r.stderr.toString().trim()}`);
  }

  console.log(`${done.join("\n")}

For another MCP client, add a stdio server with this command:
  ${command.join(" ")}

Agents start it in their workspace, and it starts the workspace's hub. To watch: witness open`);
}
