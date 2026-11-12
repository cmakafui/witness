// Relate through bun:ffi: values cross intact, a store keeps its data, and only one process writes it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relate } from "../src/relate.ts";

const dirs: string[] = [];
const store = () => {
  const d = mkdtempSync(join(tmpdir(), "witness-"));
  dirs.push(d);
  return join(d, "store");
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

test("values cross the ABI intact", () => {
  const db = Relate.open(":memory:");
  const [row] = db.query("RETURN 1 AS n, 2.5 AS f, true AS b, null AS z, $s AS s, $l AS l, {k: 'v'} AS m", {
    s: "Is it exact? 🎯",
    l: ["a.csv", "b.json"],
  });
  expect(row).toEqual({ n: 1, f: 2.5, b: true, z: null, s: "Is it exact? 🎯", l: ["a.csv", "b.json"], m: { k: "v" } });
  db.close();
});

test("a directory store keeps its data, and a read-only open refuses writes", () => {
  const path = store();
  const db = Relate.open(path);
  db.query("CREATE (:Question {id: $id})", { id: "q-1" });
  db.close();
  const ro = Relate.open(path, { readOnly: true });
  expect(ro.query("MATCH (q:Question) RETURN q.id AS id")).toEqual([{ id: "q-1" }]);
  expect(() => ro.query("CREATE (:Question {id: 'q-2'})")).toThrow(/read/i);
  ro.close();
});

test("while one process writes a store, another can read it but not write it", async () => {
  const path = store();
  const db = Relate.open(path);
  db.query("CREATE (:Question {id: 'q-1'})");
  const other = Bun.spawn(
    [
      "bun",
      "-e",
      `import { Relate } from "${join(import.meta.dir, "..", "src", "relate.ts")}";
       let writer = "opened"; try { Relate.open(process.argv[1]); } catch { writer = "refused"; }
       const r = Relate.open(process.argv[1], { readOnly: true });
       console.log(JSON.stringify({ writer, read: r.query("MATCH (q:Question) RETURN q.id AS id") }));`,
      path,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const out = JSON.parse(await new Response(other.stdout).text());
  expect(out).toEqual({ writer: "refused", read: [{ id: "q-1" }] });
  db.close();
});
