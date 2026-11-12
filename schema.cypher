// Witness: the graph type. Not yet run against Relate; check that it parses and what the engine enforces.

CREATE GRAPH TYPE witness AS {
  (a:Agent => {name :: STRING NOT NULL}),
  (q:Question => {id :: STRING NOT NULL, text :: STRING NOT NULL}),
  (r:Run => {id :: STRING NOT NULL, key :: STRING NOT NULL}),
  (b:Blob => {sha :: STRING NOT NULL}),
  (v:Verdict => {answer :: STRING NOT NULL}),

  (a)-[:ASKED]->(q),
  (q)-[:NEEDS]->(q),
  (r)-[:ANSWERS]->(q),
  (r)-[:READ => {as :: STRING NOT NULL}]->(b),
  (r)-[:SAVED => {name :: STRING NOT NULL}]->(b),
  (v)-[:OF]->(r)
};

ALTER CURRENT GRAPH TYPE SET GRAPH TYPE witness;

CREATE CONSTRAINT agent_name FOR (n:Agent) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT question_id FOR (n:Question) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT run_id FOR (n:Run) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT blob_sha FOR (n:Blob) REQUIRE n.sha IS UNIQUE;
