// Witness: the graph type. test/schema.test.ts checks that Relate parses it and enforces it.
// Relate enforces required properties, types, unique ids and edge endpoints. It accepts other labels and SET.
// The graph holds questions and the evidence for their answers. It does not hold agents.
// The hub is the only writer. It only creates. It gives every write a number (seq), in order.
// Two records hold everything: a Question when it is asked, a Run when it ends. A File's id is its SHA-256.

CREATE GRAPH TYPE witness AS {
  (q:Question => {id :: STRING NOT NULL, text :: STRING NOT NULL, rule :: STRING NOT NULL, probe :: STRING NOT NULL,
                  inputs :: LIST<STRING NOT NULL> NOT NULL, timeout :: INTEGER NOT NULL,
                  asker :: STRING, seq :: INTEGER NOT NULL}),
  (r:Run => {id :: STRING NOT NULL, key :: STRING NOT NULL, seq :: INTEGER NOT NULL, started :: INTEGER NOT NULL, ms :: INTEGER NOT NULL,
             answer :: STRING NOT NULL, reason :: STRING, measured :: BOOLEAN, results :: STRING NOT NULL,
             packages :: LIST<STRING NOT NULL> NOT NULL, lock :: STRING, log :: STRING NOT NULL}),
  (f:File => {id :: STRING NOT NULL, bytes :: INTEGER NOT NULL}),

  (q)-[:NEEDS]->(q),
  (r)-[:OF]->(q),
  (r)-[:READ => {name :: STRING NOT NULL}]->(f),
  (r)-[:SAVED => {name :: STRING NOT NULL}]->(f)
};

ALTER CURRENT GRAPH TYPE SET GRAPH TYPE witness;

CREATE CONSTRAINT question_id FOR (n:Question) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT run_id FOR (n:Run) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT file_id FOR (n:File) REQUIRE n.id IS UNIQUE;
