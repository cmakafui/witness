// Applies schema.cypher to a store: the graph type, then the constraints. Then the full-text indexes (src/graph.ts).
import { join } from "node:path";
import { SEARCH_INDEXES } from "./graph.ts";
import type { Relate } from "./relate.ts";

const SCHEMA = join(import.meta.dir, "..", "schema.cypher");

/** The statements of schema.cypher, without comments. */
export async function statements(): Promise<string[]> {
  const src = await Bun.file(SCHEMA).text();
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Applies the schema to a new store, and the indexes that search it. */
export async function applySchema(db: Relate) {
  for (const s of [...(await statements()), ...SEARCH_INDEXES]) db.query(s);
}
