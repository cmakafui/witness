// schema.cypher parses, and Relate enforces it: required properties, types, unique ids and edge endpoints.
// The graph type is open: Relate accepts labels it does not declare, and SET. The hub must only create.
import { beforeEach, expect, test } from "bun:test";
import { Relate } from "../src/relate.ts";
import { applySchema } from "../src/schema.ts";

let db: Relate;
beforeEach(async () => {
  db = Relate.open(":memory:");
  await applySchema(db);
});

const question = "CREATE (:Question {id: $id, text: 't', rule: '$x = 1', probe: 'p', inputs: ['data.csv'], timeout: 600, seq: 1})";
const run = "CREATE (:Run {id: 'r-1', key: 'k', seq: 2, answer: 'yes', results: '[]', packages: ['numpy==2.3.4'], log: 'l'})";

test("a well-formed question and run are accepted", () => {
  db.query(question, { id: "q-1" });
  db.query(`MATCH (q:Question {id: 'q-1'}) ${run.replace("CREATE (:Run", "CREATE (r:Run")} CREATE (r)-[:OF]->(q)`);
  expect(db.query("MATCH (r:Run)-[:OF]->(q:Question) RETURN q.id AS id, r.packages AS packages")).toEqual([{ id: "q-1", packages: ["numpy==2.3.4"] }]);
});

test("a question without its probe is rejected, and a run without its answer", () => {
  expect(() => db.query("CREATE (:Question {id: 'q-1', text: 't', rule: '$x = 1', inputs: [], timeout: 600, seq: 1})")).toThrow(/requires properties/);
  expect(() => db.query(run.replace("answer: 'yes', ", ""))).toThrow(/requires properties/);
});

test("a property of the wrong type is rejected", () => {
  expect(() => db.query("CREATE (:Question {id: 'q-1', text: 't', rule: '$x = 1', probe: 'p', inputs: [], timeout: 600, seq: 'one'})")).toThrow(/property type/);
});

test("two questions with one id are rejected", () => {
  db.query(question, { id: "q-1" });
  expect(() => db.query(question, { id: "q-1" })).toThrow(/uniqueness/);
});

test("an edge between the wrong kinds of node is rejected", () => {
  db.query(question, { id: "q-1" });
  expect(() => db.query("MATCH (q:Question {id: 'q-1'}) CREATE (q)-[:OF]->(q)")).toThrow(/endpoint/);
});
