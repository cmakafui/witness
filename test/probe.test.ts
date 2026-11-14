import { expect, test } from "bun:test";
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
