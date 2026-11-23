// Runs one probe with uv, in a new folder that holds only the probe and its declared inputs.
//
// A probe measures. It does not answer: the question's rule decides, from the measurements (src/hub.ts).
//   WITNESS_RESULT {json object}   any number of times: a measurement, by name
// It saves files for other questions in $WITNESS_OUT. A probe that crashes, times out, or prints a result that is
// not a JSON object has failed. A failed run is never a "no".
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const RESULT = "WITNESS_RESULT";

export type ProbeRun = {
  probe: string; // the Python source
  inputs: { name: string; path?: string; content?: Uint8Array }[]; // name: relative path in work/; path or content: bytes
  timeoutS: number;
};

export type ProbeOutcome = {
  failed: string | null; // why the run failed, or null when it measured
  results: Record<string, unknown>[];
  outputs: { name: string; path: string }[];
  started: number; // when the run began: milliseconds since 1970
  ms: number; // how long the run took
  cleanup: () => void; // removes the run's folder, after the hub keeps the outputs
};

const uv = Bun.which("uv");
const REAP = join(import.meta.dir, "reap.ts");

const READS = join(import.meta.dir, "reads");

/**
 * The environment of a probe: what uv and Python need, and nothing else. No credential reaches a probe.
 * PYTHONPATH loads src/reads/sitecustomize.py, which writes to `reads` each path the probe tried to read but did not have.
 */
function environment(out: string, reads: string): Record<string, string> {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR"];
  const env: Record<string, string> = { WITNESS_OUT: out, PYTHONUNBUFFERED: "1", PYTHONPATH: READS, WITNESS_READS: reads };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** A sentence that names the paths a failed probe tried to read but did not have, or "" when there are none. */
function undeclared(reads: string): string {
  let lines: string[];
  try {
    lines = readFileSync(reads, "utf8").split("\n");
  } catch {
    return "";
  }
  const paths = [...new Set(lines.filter((l) => l && !l.startsWith("<")))];
  // A folder that a listed path is inside says nothing more: keep data/*.zip, drop data.
  const kept = paths.filter((p) => !paths.some((q) => q !== p && q.startsWith(`${p}/`)));
  const shown = kept.slice(0, 5);
  if (!shown.length) return "";
  const list = shown.join(", ") + (kept.length > shown.length ? " and more" : "");
  return `\nThe probe tried to read ${list}, which ${shown.length === 1 ? "is not a declared input" : "are not declared inputs"}. Declare each file the probe reads in inputs.`;
}

function files(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p, base) : [p.slice(base.length + 1)];
  });
}

const UV_NOISE = /^(?:Reading inline script metadata from |Installed \d+ package|Resolved \d+ package|Prepared \d+ package|Downloaded \d+ package|Updated https?:\/\/)/;
const tail = (s: string, n = 15) => {
  const lines = s.trim().split("\n");
  const filtered = lines.filter((l) => !UV_NOISE.test(l.trim()));
  return (filtered.length ? filtered : lines).slice(-n).join("\n");
};
const DIAGNOSTIC_CHARS = 4096;

export async function runProbe(run: ProbeRun): Promise<ProbeOutcome> {
  const began = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "witness-run-"));
  const work = join(dir, "work");
  const out = join(dir, "out");
  mkdirSync(work);
  mkdirSync(out);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const done = (o: Partial<ProbeOutcome> & Pick<ProbeOutcome, "failed">): ProbeOutcome => ({
    started: began,
    ms: Date.now() - began,
    results: [],
    outputs: [],
    cleanup,
    ...o,
  });

  if (!uv) return done({ failed: "uv is not installed on this machine" });
  await Bun.write(join(work, "probe.py"), run.probe);
  for (const input of run.inputs) {
    const target = join(work, input.name);
    mkdirSync(dirname(target), { recursive: true });
    if (input.content !== undefined) await Bun.write(target, input.content);
    else cpSync(input.path!, target);
  }
  const reads = join(dir, "reads"); // outside work and out: the probe neither reads nor saves it
  const env = environment(out, reads);

  // Through src/reap.ts, so no process of the probe outlives the hub. The timeout below still kills the whole group.
  const proc = Bun.spawn([process.execPath, "--no-orphans", REAP, uv, "run", "--script", "probe.py"], {
    cwd: work,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32")
      Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    else {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    }
  }, run.timeoutS * 1000);
  const results: Record<string, unknown>[] = [];
  let badResult: string | null = null;
  // Keep only a short diagnostic tail. Measurements live in results, not in a transcript.
  let diagnostic = "";
  const remember = (s: string) => { diagnostic = (diagnostic + s).slice(-DIAGNOSTIC_CHARS); };
  const read = async (stream: ReadableStream<Uint8Array>, protocol: boolean) => {
    let buf = "";
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      if (!protocol) {
        remember(decoder.decode(bytes, { stream: true }));
        continue;
      }
      buf += decoder.decode(bytes, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    if (protocol) {
      buf += decoder.decode();
      if (buf) line(buf);
    } else remember(decoder.decode());
  };
  const line = (l: string) => {
    if (l.startsWith(`${RESULT} `)) {
      try {
        const data = JSON.parse(l.slice(RESULT.length + 1));
        if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
        results.push(data);
      } catch {
        badResult ??= l.slice(0, DIAGNOSTIC_CHARS);
      }
    } else remember(`${l}\n`);
  };
  let code: number;
  try {
    await Promise.all([read(proc.stdout, true), read(proc.stderr, false)]);
    code = await proc.exited;
  } finally {
    clearTimeout(timer);
  }

  const outputs = files(out).map((name) => ({ name, path: join(out, name) }));
  const base = { results, outputs };
  const failed = (reason: string) => done({ ...base, failed: reason + undeclared(reads) });
  if (timedOut) return failed(`timed out after ${run.timeoutS} s`);
  if (proc.signalCode) return failed(`stopped by ${proc.signalCode}`);
  if (code !== 0) return failed(`exit code ${code}:\n${tail(diagnostic)}`);
  if (badResult) return failed(`a ${RESULT} line is not a JSON object: ${badResult}`);
  if (!results.length) return failed(`measured nothing: it printed no ${RESULT} line`);
  return done({ ...base, failed: null });
}

/**
 * What is wrong with the probe's dependencies, or null. A probe that installs packages must fix the date that uv
 * resolves them at, with exclude-newer under [tool.uv]. The probe text is in the run key, so the cutoff is part
 * of that key. It limits eligible package uploads; it does not lock the Python version or the full environment.
 */
export function dependencyProblem(probe: string): string | null {
  const block = /^# \/\/\/ script\s*$([\s\S]*?)^# \/\/\/\s*$/m.exec(probe);
  if (!block) return null;
  let meta: { dependencies?: unknown[]; tool?: { uv?: { "exclude-newer"?: unknown } } };
  try {
    meta = Bun.TOML.parse(block[1]!.split("\n").map((l) => l.replace(/^# ?/, "")).join("\n")) as never;
  } catch (e) {
    return `The probe's script header is not valid TOML: ${(e as Error).message}`;
  }
  if (!meta.dependencies?.length) return null;
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const fix = `Add these lines before "# ///": "# [tool.uv]" and "# exclude-newer = \"${today}\"".`;
  const date = meta.tool?.uv?.["exclude-newer"];
  if (date === undefined) return `The probe installs packages but fixes no date to resolve them at. ${fix}`;
  if (date instanceof Date || (typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) && !Number.isNaN(Date.parse(date))))
    return null;
  return `exclude-newer must be a fixed date, not ${JSON.stringify(date)}: a relative date resolves differently each day. ${fix}`;
}

/** True when the path is a file, not a folder. */
export const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
