import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbe } from "../src/probe.ts";

const script = (body: string) => `# /// script\n# dependencies = []\n# ///\n${body}\n`;

test.each(["stdout", "stderr"])("a failed probe keeps a bounded %s diagnostic tail", async (stream) => {
  const outcome = await runProbe({
    probe: script(`import sys\nsys.${stream}.write("discard this prefix\\n" + "x" * 100000 + "\\nuseful final diagnostic\\n")\nraise SystemExit(3)`),
    inputs: [],
    timeoutS: 10,
  });
  try {
    expect(outcome.failed).toContain("exit code 3:");
    expect(outcome.failed).toContain("useful final diagnostic");
    expect(outcome.failed).not.toContain("discard this prefix");
    expect(outcome.failed!.length).toBeLessThan(4200);
    expect(outcome.outputs).toEqual([]);
  } finally {
    outcome.cleanup();
  }
});

test("uv dependency errors become failed runs with diagnostics", async () => {
  const outcome = await runProbe({
    probe: script('print("WITNESS_RESULT {}")').replace("dependencies = []", 'dependencies = ["not a valid requirement ???"]'),
    inputs: [],
    timeoutS: 10,
  });
  try {
    expect(outcome.failed).toMatch(/exit code [1-9]/);
    expect(outcome.failed).toMatch(/requirement|dependencies/i);
    expect(outcome.results).toEqual([]);
  } finally {
    outcome.cleanup();
  }
});

test("the asynchronous uv run obeys the probe timeout", async () => {
  const outcome = await runProbe({ probe: script("import time\ntime.sleep(30)"), inputs: [], timeoutS: 0.2 });
  try {
    expect(outcome.failed).toBe("timed out after 0.2 s");
    expect(outcome.results).toEqual([]);
  } finally {
    outcome.cleanup();
  }
});

test("a failed run names the files the probe tried to read but did not declare", async () => {
  const dir = mkdtempSync(join(tmpdir(), "witness-declared-"));
  writeFileSync(join(dir, "data.txt"), "1 2 3");
  const outcome = await runProbe({
    probe: script(`import pathlib\nprint(pathlib.Path("data.txt").read_text())\npathlib.Path("scratch/traffic/apr28.json").read_text()`),
    inputs: [{ name: "data.txt", path: join(dir, "data.txt") }],
    timeoutS: 30,
  });
  try {
    expect(outcome.failed).toContain("FileNotFoundError");
    expect(outcome.failed).toContain("The probe tried to read scratch/traffic/apr28.json, which is not a declared input.");
    expect(outcome.failed).not.toContain("data.txt,");
  } finally {
    outcome.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads that the probe caught are named too, and a passing run is unchanged", async () => {
  const quiet = `import glob, json\nfound = glob.glob("data/*.zip")\ntry:\n    open("scratch/arrays.npy", "rb")\nexcept FileNotFoundError:\n    pass\nwith open("made-here.txt", "w") as f:\n    f.write("not a read")\n`;
  const failing = await runProbe({ probe: script(quiet), inputs: [], timeoutS: 30 });
  const passing = await runProbe({ probe: script(`${quiet}print("WITNESS_RESULT", json.dumps({"n": len(found)}))`), inputs: [], timeoutS: 30 });
  try {
    expect(failing.failed).toStartWith("measured nothing");
    expect(failing.failed).toContain("The probe tried to read data/*.zip, scratch/arrays.npy, which are not declared inputs.");
    expect(failing.failed).not.toContain("made-here.txt");
    expect(passing.failed).toBeNull();
    expect(passing.results).toEqual([{ n: 0 }]);
  } finally {
    failing.cleanup();
    passing.cleanup();
  }
});
