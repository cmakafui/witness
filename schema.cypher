// Witness: the graph type. Not yet run against Relate. Check that it parses and what the engine enforces.
// The graph holds questions and the evidence for their answers. It does not hold agents.
// The hub is the only writer. It only creates. It gives every write a number (seq), in order.

CREATE GRAPH TYPE witness AS {
  (q:Question => {id :: STRING NOT NULL, text :: STRING NOT NULL, rule :: STRING NOT NULL,
                  inputs :: LIST<STRING NOT NULL> NOT NULL, by :: STRING, seq :: INTEGER NOT NULL}),
  (r:Run => {id :: STRING NOT NULL, key :: STRING NOT NULL, seq :: INTEGER NOT NULL}),
  (a:Answer => {value :: STRING NOT NULL, results :: STRING NOT NULL, seq :: INTEGER NOT NULL}),
  (f:File => {sha :: STRING NOT NULL, bytes :: INTEGER NOT NULL}),
  (p:Package => {name :: STRING NOT NULL, version :: STRING NOT NULL}),

  (q)-[:PROBE]->(f),
  (q)-[:NEEDS]->(q),
  (q)-[:DISPUTES]->(q),
  (r)-[:ANSWERS]->(q),
  (r)-[:READ => {as :: STRING NOT NULL}]->(f),
  (r)-[:SAVED => {name :: STRING NOT NULL}]->(f),
  (r)-[:USED]->(p),
  (a)-[:OF]->(r)
};

ALTER CURRENT GRAPH TYPE SET GRAPH TYPE witness;

CREATE CONSTRAINT question_id FOR (n:Question) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT run_id FOR (n:Run) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT file_sha FOR (n:File) REQUIRE n.sha IS UNIQUE;
CREATE CONSTRAINT package_key FOR (n:Package) REQUIRE (n.name, n.version) IS NODE KEY;
