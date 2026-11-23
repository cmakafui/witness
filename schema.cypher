// Witness: the graph type. test/schema.test.ts checks that Relate parses it and enforces it.
// Relate enforces required properties, types, unique ids and the ends of each relationship.
// The graph holds goals, questions, runs and files. It does not hold agents.
// The hub is the only writer, and it only creates. It gives every goal, question and run a number (seq), in order.
// A goal has at most one acceptance question. The hub binds it before that question runs.
// A File's id is its SHA-256. NEEDS, READ and SAVED carry the name of the input or the saved file.
// src/schema.ts also adds the full-text indexes (SEARCH_INDEXES in src/graph.ts).

CREATE GRAPH TYPE witness AS {
  (g:Goal => {id :: STRING NOT NULL, text :: STRING NOT NULL, seq :: INTEGER NOT NULL, created :: INTEGER NOT NULL}),
  (q:Question => {id :: STRING NOT NULL, text :: STRING NOT NULL, rule :: STRING NOT NULL, probe :: STRING NOT NULL,
                  inputs :: LIST<STRING NOT NULL> NOT NULL, timeout :: INTEGER NOT NULL,
                  lane :: STRING, seq :: INTEGER NOT NULL, created :: INTEGER NOT NULL}),
  (r:Run => {id :: STRING NOT NULL, key :: STRING NOT NULL, seq :: INTEGER NOT NULL, started :: INTEGER NOT NULL, ms :: INTEGER NOT NULL,
             answer :: STRING NOT NULL, reason :: STRING, measured :: BOOLEAN NOT NULL, results :: STRING NOT NULL, last :: STRING}),
  (f:File => {id :: STRING NOT NULL}),

  (g)-[:ACCEPTED_BY]->(q),
  (q)-[:NEEDS => {name :: STRING NOT NULL}]->(q),
  (q)-[:REPLACES]->(q),
  (r)-[:OF]->(q),
  (r)-[:READ => {name :: STRING NOT NULL}]->(f),
  (r)-[:SAVED => {name :: STRING NOT NULL}]->(f)
};

ALTER CURRENT GRAPH TYPE SET GRAPH TYPE witness;

CREATE CONSTRAINT goal_id FOR (n:Goal) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT question_id FOR (n:Question) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT run_id FOR (n:Run) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT file_id FOR (n:File) REQUIRE n.id IS UNIQUE;
