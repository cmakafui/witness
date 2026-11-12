// Witness: the graph type. test/schema.test.ts checks that Relate parses it and enforces it.
// Relate enforces required properties, types, unique ids and edge endpoints. It accepts other labels and SET.
// The graph holds questions and the evidence for their answers. It does not hold agents.
// The hub is the only writer. It only creates. It gives every write a number (seq), in order.
// Every node has an id. A File's id is the SHA-256 of its content. A Package's id is name@version.

CREATE GRAPH TYPE witness AS {
  (q:Question => {id :: STRING NOT NULL, text :: STRING NOT NULL, rule :: STRING NOT NULL,
                  inputs :: LIST<STRING NOT NULL> NOT NULL, timeout :: INTEGER NOT NULL,
                  asker :: STRING, seq :: INTEGER NOT NULL}),
  (r:Run => {id :: STRING NOT NULL, key :: STRING NOT NULL, seq :: INTEGER NOT NULL}),
  (a:Answer => {id :: STRING NOT NULL, value :: STRING NOT NULL, reason :: STRING,
                results :: STRING NOT NULL, seq :: INTEGER NOT NULL}),
  (f:File => {id :: STRING NOT NULL, bytes :: INTEGER NOT NULL}),
  (p:Package => {id :: STRING NOT NULL, name :: STRING NOT NULL, version :: STRING NOT NULL}),

  (q)-[:PROBE]->(f),
  (q)-[:NEEDS]->(q),
  (q)-[:DISPUTES]->(q),
  (r)-[:ANSWERS]->(q),
  (r)-[:READ => {role :: STRING NOT NULL, name :: STRING NOT NULL}]->(f),
  (r)-[:SAVED => {name :: STRING NOT NULL}]->(f),
  (r)-[:USED]->(p),
  (a)-[:OF]->(r),
  (a)-[:LOG]->(f)
};

ALTER CURRENT GRAPH TYPE SET GRAPH TYPE witness;

CREATE CONSTRAINT question_id FOR (n:Question) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT run_id FOR (n:Run) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT answer_id FOR (n:Answer) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT file_id FOR (n:File) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT package_id FOR (n:Package) REQUIRE n.id IS UNIQUE;
