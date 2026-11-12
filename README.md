# Witness

See how a team of AI agents does research, and check every step.

Agents work together on a hard problem. Each finding starts as a yes/no question. A probe answers the question: a short Python script that runs with [uv](https://docs.astral.sh/uv/) and can use any package from PyPI. [Relate](https://relatedb.ai) keeps the questions, the runs and their answers in one graph. You can watch the graph grow while the agents work. You can also ask the graph why the agents believe a result, and what they did not test.

> Status: skeleton. Made for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (Nov 11 – Dec 11, 2026).

## The problem

Agents that work on a hard problem make many claims. Most claims depend on other claims. When the claims are only text, you cannot see which claims a run tested. You cannot see which claims depend on a result that later changed. You cannot see if the agents tried to prove themselves wrong.

In Witness, a claim counts only when a run answers it. The graph records what each answer depends on. So you can ask these questions at any time:

- Which "yes" answers did no question try to disprove?
- Which questions read the same outputs, so that two agents do the same work?
- Which packages did the agents use, and when did each package first appear?
- Which questions and outputs does the final result depend on?

## The graph

```
(:Question {text, rule, inputs, by})-[:PROBE]->(:File)
(:Question)-[:NEEDS]->(:Question)            // reads an output of the other question
(:Question)-[:DISPUTES]->(:Question)         // tries to show that the other answer is wrong
(:Run)-[:ANSWERS]->(:Question)
(:Run)-[:READ {as}]->(:File)                 // data, outputs of other runs, a picture
(:Run)-[:SAVED {name}]->(:File)
(:Run)-[:USED]->(:Package {name, version})   // from the probe's uv lock file
(:Answer {value})-[:OF]->(:Run)              // yes, no or failed
```

The graph holds questions and the evidence for their answers. It does not hold agents. A question can have an optional `by` text, so the page can show who asked it.

A `File` is content, named by its SHA-256 hash. The `rule` of a question says how the probe decides yes or no. The probe gets the rule before it measures anything.

Witness never changes or deletes a record. The answer to a question is the answer of the run that read the current inputs. When an input changes, Witness runs the questions that depend on it again. The schema is in [`schema.cypher`](schema.cypher).

## How it uses Relate

- Mode: directory (to confirm when the store runs)
- Why this mode:
- What the graph models: the questions, the runs that answered them, and the files and packages that each answer depends on.

## Parts

- **Bun 1.4:** the hub. It gives agents three tools over MCP: `ask`, `query` (read-only Cypher) and `look`. It also sends each change to the web page.
- **Relate:** the store. The hub opens it with `bun:ffi` and is the only process that writes to it.
- **uv:** runs each probe with `uv run --script`.

## Build order

1. The hub, the store, and `ask` with uv probes. Test them in the terminal.
2. `NEEDS`, `DISPUTES`, and packages from the uv lock file. Then `query` and `look`.
3. The web page. It shows runs as they happen, and the chain of questions behind a result.
4. A recorded session on the causal-hunt problem, the saved store, a replay for the judges, and this README.

## Setup and run

To come.

## Where the data lives

To come.
