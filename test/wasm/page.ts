/// <reference lib="dom" />
// Runs Relate's WASM build in the page and writes the result where the test can read it.
import init, { RelateDb } from "@relate/relate-wasm";
import wasmUrl from "@relate/relate-wasm/relate_bg.wasm" with { type: "file" };

const out = document.getElementById("out")!;
try {
  await init({ module_or_path: wasmUrl });
  const db = new RelateDb();
  db.execute("CREATE (:Question {id: 'q-1'})-[:NEEDS]->(:Question {id: 'q-0'})", null);
  const result = JSON.parse(db.execute("MATCH (a:Question)-[:NEEDS]->(b) RETURN a.id AS a, b.id AS b", null));
  out.textContent = `OK ${JSON.stringify(result.rows)}`;
} catch (e) {
  out.textContent = `FAIL ${String(e)}`;
}
