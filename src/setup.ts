// witness setup: links the skill into Claude Code, Codex, Pi and Antigravity (agy), and registers the MCP server with Claude Code, Codex, Pi and agy.
// MCP clients start servers without the user's shell profile, so the command names Bun and Witness by full path.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAIN } from "./connect.ts";

const SKILL = join(import.meta.dir, "..", "skill", "witness");
/** ask waits up to 240 s for an answer. Codex and Pi give up on a tool call sooner unless its server says otherwise. */
const CODEX_TIMEOUT_S = 300;
const PI_TIMEOUT_S = 300;
/** Pi's config folder. PI_CODING_AGENT_DIR moves it. */
const piDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

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

/** Adds timeout to Pi's witness server in mcp.json when it has none. Changes nothing else. */
export function piTimeout(config: string): string {
  const parsed = JSON.parse(config) as { mcpServers?: Record<string, Record<string, unknown>> };
  const server = parsed.mcpServers?.witness;
  if (!server || server.timeout !== undefined) return config;
  server.timeout = PI_TIMEOUT_S;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Links the skill into an agent's skills folder, unless something that is not a link is already there. */
function linkSkill(target: string, agent: string): string {
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) return `${agent} skill: left ${target} as it is (it is not a link to Witness)`;
  rmSync(target, { force: true });
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(SKILL, target);
  return `${agent} skill: ${target} -> ${SKILL}`;
}

export function setup() {
  const command = [process.execPath, MAIN, "mcp"];
  const done: string[] = [];

  done.push(linkSkill(join(homedir(), ".claude", "skills", "witness"), "Claude Code"));

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
    // Codex reads user skills from ~/.agents/skills, the shared agent-skills folder.
    done.push(linkSkill(join(homedir(), ".agents", "skills", "witness"), "Codex"));
    done.push(r.exitCode === 0 ? `Codex: added the witness MCP server, with tool_timeout_sec = ${CODEX_TIMEOUT_S}` : `Codex: could not add the server: ${r.stderr.toString().trim()}`);
  }

  if (Bun.which("pi")) {
    done.push(linkSkill(join(piDir(), "skills", "witness"), "Pi"));
    Bun.spawnSync(["pi", "mcp", "remove", "witness"], { stdout: "ignore", stderr: "ignore" });
    // Four small tools that agents call all the time: declare them to the model, without a search step.
    const description = "Tested answers for a team of agents: ask yes/no questions that a probe measures and a rule decides.";
    const r = Bun.spawnSync(["pi", "mcp", "add", "witness", "--exposure", "direct", "--description", description, "--", ...command], { stderr: "pipe" });
    const config = join(piDir(), "mcp.json");
    if (r.exitCode === 0 && existsSync(config)) writeFileSync(config, piTimeout(readFileSync(config, "utf8")));
    done.push(r.exitCode === 0 ? `Pi: added the witness MCP server, with direct tools and timeout = ${PI_TIMEOUT_S}` : `Pi: could not add the server: ${r.stderr.toString().trim()}`);
  }

  if (Bun.which("agy")) {
    // agy has no tool timeout setting for MCP servers, so ask keeps agy's default.
    done.push(linkSkill(join(homedir(), ".gemini", "config", "skills", "witness"), "agy"));
    Bun.spawnSync(["agy", "mcp", "remove", "witness"], { stdout: "ignore", stderr: "ignore" });
    const r = Bun.spawnSync(["agy", "mcp", "add", "witness", "--", ...command], { stderr: "pipe" });
    done.push(r.exitCode === 0 ? "agy: added the witness MCP server" : `agy: could not add the server: ${r.stderr.toString().trim()}`);
  }

  console.log(`${done.join("\n")}

For another MCP client, add a stdio server with this command:
  ${command.join(" ")}

Agents start it in their workspace, and it starts the workspace's hub. To watch: witness open`);
}
