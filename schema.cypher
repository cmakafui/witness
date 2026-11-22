// Witness: the graph type. test/schema.test.ts checks that Relate parses it and enforces it.
// Relate enforces required properties, types, unique ids and edge endpoints. It accepts other labels and SET.
// The graph holds questions and the evidence for their answers. It does not hold agents.
// The hub is the only writer. It only creates. It gives every write a number (seq), in order.
// Goals, questions and runs are immutable records. Goal completion is derived from its acceptance question.
// The hub binds at most one acceptance question per goal, before that question runs. A File's id is its SHA-256.
// A question can replace a question whose run crashed or timed out. The hub writes REPLACES with the new question.
// NEEDS carries the input it names, q-…/file, one per file. A store made before 0.12.0 holds NEEDS without a name.

CREATE GRAPH TYPE witness AS {
  (g:Goal => {id :: STRING NOT NULL, text :: STRING NOT NULL, seq :: INTEGER NOT NULL}),
  (q:Question => {id :: STRING NOT NULL, text :: STRING NOT NULL, rule :: STRING NOT NULL, probe :: STRING NOT NULL,
                  inputs :: LIST<STRING NOT NULL> NOT NULL, timeout :: INTEGER NOT NULL,
                  asker :: STRING, seq :: INTEGER NOT NULL}),
  (r:Run => {id :: STRING NOT NULL, key :: STRING NOT NULL, seq :: INTEGER NOT NULL, started :: INTEGER NOT NULL, ms :: INTEGER NOT NULL,
             answer :: STRING NOT NULL, reason :: STRING, measured :: BOOLEAN, results :: STRING NOT NULL}),
  (f:File => {id :: STRING NOT NULL}),

  (g)-[:ACCEPTED_BY]->(q),
  (q)-[:NEEDS => {name :: STRING}]->(q),
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
