// witness setup: links the skill into Claude Code and registers the MCP server with Claude Code and Codex.
// MCP clients start servers without the user's shell profile, so the command names Bun and Witness by full path.
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MAIN } from "./connect.ts";

const SKILL = join(import.meta.dir, "..", "skill", "witness");

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
    done.push(r.exitCode === 0 ? "Codex: added the witness MCP server" : `Codex: could not add the server: ${r.stderr.toString().trim()}`);
  }

  console.log(`${done.join("\n")}

For another MCP client, add a stdio server with this command:
  ${command.join(" ")}

Agents start it in their workspace. It starts the workspace's hub when none runs.
The page shows the address; run "witness status" in the workspace to see it.`);
}
