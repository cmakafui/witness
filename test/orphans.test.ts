import { expect, test } from "bun:test";
import { join } from "node:path";

// A hub that dies, even by SIGKILL, must not leave any process of a probe running.
const probeTs = join(import.meta.dir, "..", "src", "probe.ts");
const count = (tag: string) => Bun.spawnSync(["pgrep", "-f", `sleep ${tag}`]).stdout.toString().split("\n").filter(Boolean).length;

async function until(check: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (check()) return true;
  return check();
}

test.skipIf(process.platform === "win32")("no probe process outlives a hub killed with SIGKILL", async () => {
  const tag = String(70000 + Math.floor(Math.random() * 9999));
  // The probe starts a process of its own, as uv starts Python and Python may start more, then waits.
  const probe = `# /// script\n# dependencies = []\n# ///\nimport subprocess, time\nsubprocess.Popen(["sleep", "${tag}"])\ntime.sleep(120)\n`;
  const hub = Bun.spawn(
    [process.execPath, "-e", `const { runProbe } = await import(${JSON.stringify(probeTs)}); await runProbe({ probe: ${JSON.stringify(probe)}, inputs: [], timeoutS: 300 });`],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    expect(await until(() => count(tag) > 0, 30_000)).toBe(true);
    hub.kill("SIGKILL");
    await hub.exited;
    expect(await until(() => count(tag) === 0, 5_000)).toBe(true);
  } finally {
    hub.kill("SIGKILL");
    Bun.spawnSync(["pkill", "-f", `sleep ${tag}`]);
  }
}, 60_000);
