// Runs one probe with uv, in a new folder that holds only the probe and its declared inputs.
//
// The probe prints lines to tell its result:
//   WITNESS_RESULT {json}   any number of times: a measurement
//   WITNESS_ANSWER yes|no   exactly once: the answer
// It saves files for other questions in $WITNESS_OUT. A probe that crashes, times out, or does not answer exactly
// once has failed. A failed run is never a "no".
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const RESULT = "WITNESS_RESULT";
export const ANSWER = "WITNESS_ANSWER";

export type ProbeRun = {
  probe: string; // the Python source
  inputs: { name: string; path: string }[]; // name: where the probe finds it (relative); path: where it is now
  timeoutS: number;
  onResult?: (data: unknown) => void;
};

export type ProbeOutcome = {
  answer: "yes" | "no" | "failed";
  reason: string | null;
  results: unknown[];
  outputs: { name: string; path: string }[];
  lock: string | null; // probe.py.lock, as uv wrote it
  packages: { name: string; version: string }[];
  log: string;
  cleanup: () => void; // removes the run's folder, after the hub keeps the outputs
};

const uv = Bun.which("uv");

/** The environment of a probe: what uv and Python need, and nothing else. No credential reaches a probe. */
function environment(out: string): Record<string, string> {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR"];
  const env: Record<string, string> = { WITNESS_OUT: out, PYTHONUNBUFFERED: "1" };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** The packages that a uv lock file pins, without the probe itself. */
export function lockedPackages(lock: string): { name: string; version: string }[] {
  const parsed = Bun.TOML.parse(lock) as { package?: { name: string; version?: string; source?: Record<string, unknown> }[] };
  return (parsed.package ?? []).filter((p) => p.version && !p.source?.virtual && !p.source?.editable).map((p) => ({ name: p.name, version: p.version! }));
}

function files(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p, base) : [p.slice(base.length + 1)];
  });
}

const tail = (s: string, n = 6) => s.trim().split("\n").slice(-n).join("\n");

export async function runProbe(run: ProbeRun): Promise<ProbeOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "witness-run-"));
  const work = join(dir, "work");
  const out = join(dir, "out");
  mkdirSync(work);
  mkdirSync(out);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const done = (o: Partial<ProbeOutcome> & Pick<ProbeOutcome, "answer" | "log">): ProbeOutcome => ({
    reason: null,
    results: [],
    outputs: [],
    lock: null,
    packages: [],
    cleanup,
    ...o,
  });

  if (!uv) return done({ answer: "failed", reason: "uv is not installed on this machine", log: "" });
  await Bun.write(join(work, "probe.py"), run.probe);
  for (const input of run.inputs) {
    mkdirSync(dirname(join(work, input.name)), { recursive: true });
    cpSync(input.path, join(work, input.name));
  }
  const env = environment(out);

  // Resolve the probe's dependencies into a lock file. The lock is evidence: it says which packages answered.
  const lock = Bun.spawnSync([uv, "lock", "--script", "probe.py"], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
  const lockLog = lock.stdout.toString() + lock.stderr.toString();
  if (lock.exitCode !== 0) return done({ answer: "failed", reason: `uv could not resolve the probe's dependencies:\n${tail(lockLog)}`, log: lockLog });
  const lockText = await Bun.file(join(work, "probe.py.lock")).text();

  const started = performance.now();
  const proc = Bun.spawn([uv, "run", "--locked", "--script", "probe.py"], {
    cwd: work,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: run.timeoutS * 1000,
    killSignal: "SIGKILL",
  });
  const results: unknown[] = [];
  const answers: string[] = [];
  let badResult: string | null = null;
  let log = lockLog;
  const read = async (stream: ReadableStream<Uint8Array>, protocol: boolean) => {
    let buf = "";
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      buf += decoder.decode(bytes, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i), protocol);
        buf = buf.slice(i + 1);
      }
    }
    if (buf) line(buf, protocol);
  };
  const line = (l: string, protocol: boolean) => {
    log += `${l}\n`;
    if (!protocol) return;
    if (l.startsWith(`${RESULT} `)) {
      try {
        const data = JSON.parse(l.slice(RESULT.length + 1));
        results.push(data);
        run.onResult?.(data);
      } catch {
        badResult ??= l;
      }
    } else if (l.startsWith(`${ANSWER} `)) answers.push(l.slice(ANSWER.length + 1).trim());
  };
  await Promise.all([read(proc.stdout, true), read(proc.stderr, false)]);
  const code = await proc.exited;

  const outputs = files(out).map((name) => ({ name, path: join(out, name) }));
  const base = { results, outputs, lock: lockText, packages: lockedPackages(lockText), log };
  const failed = (reason: string) => done({ ...base, answer: "failed", reason });
  if (proc.signalCode && performance.now() - started >= run.timeoutS * 1000) return failed(`timed out after ${run.timeoutS} s`);
  if (proc.signalCode) return failed(`stopped by ${proc.signalCode}`);
  if (code !== 0) return failed(`exit code ${code}:\n${tail(log.slice(lockLog.length))}`);
  if (badResult) return failed(`a ${RESULT} line is not JSON: ${badResult}`);
  if (answers.length !== 1) return failed(answers.length ? `answered ${answers.length} times` : "never printed WITNESS_ANSWER");
  const [answer] = answers;
  if (answer !== "yes" && answer !== "no") return failed(`answered "${answer}", not yes or no`);
  return done({ ...base, answer, reason: null });
}

/** True when the path is a file, not a folder. */
export const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
