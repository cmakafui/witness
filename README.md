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
(:Question {text, rule, inputs, asker})-[:PROBE]->(:File)
(:Question)-[:NEEDS]->(:Question)            // reads an output of the other question
(:Question)-[:DISPUTES]->(:Question)         // tries to show that the other answer is wrong
(:Run)-[:ANSWERS]->(:Question)
(:Run)-[:READ {role}]->(:File)               // data, outputs of other runs, a picture
(:Run)-[:SAVED {name}]->(:File)
(:Run)-[:USED]->(:Package {name, version})   // from the probe's uv lock file
(:Answer {value})-[:OF]->(:Run)              // yes, no or failed
```

The graph holds questions and the evidence for their answers. It does not hold agents. A question can have an optional `asker` text, so the page can show who asked it.

A `File` is content, named by its SHA-256 hash. The `rule` of a question says how the probe decides yes or no. The probe gets the rule before it measures anything.

Witness never changes or deletes a record. The answer to a question is the answer of the run that read the current inputs. When an input changes, Witness runs the questions that depend on it again. The schema is in [`schema.cypher`](schema.cypher).

## How it uses Relate

- Mode: directory, in `.witness/graph/` of the workspace.
- Why this mode: the hub writes the graph through `bun:ffi` while it runs. A directory store keeps every write on disk as it happens, and other processes can open it read-only beside the hub. Relate lets only one process write a store, so the hub is the only writer.
- What the graph models: the questions, the runs that answered them, and the files and packages that each answer depends on.
- The web page keeps its own copy of the graph in Relate's WASM build. The hub sends each new record, and the page writes it with the same Cypher as the hub (`src/graph.ts`). The panels and the query box run Cypher in the page.

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

You need [Bun](https://bun.com) 1.4 and [uv](https://docs.astral.sh/uv/).

```bash
bun install
bun src/main.ts serve --root path/to/workspace     # the hub: the page at http://127.0.0.1:4747
claude mcp add --transport http witness http://127.0.0.1:4747/mcp
```

Agents get three tools:

| Tool | What it does |
|---|---|
| `ask` | Asks a yes/no question with a rule, a probe and its inputs. Witness runs the probe and returns the answer. |
| `query` | Runs read-only Cypher on the graph. `$yes`, `$no`, `$failed`, `$running`, `$pending` and `$waiting` are lists of question ids. `$current` lists the runs that give the current answers. |
| `look` | Shows a file that a run saved. Images come back as images. |

A probe is a Python script that uv runs. It prints `WITNESS_RESULT {json}` for each measurement and `WITNESS_ANSWER yes` or `WITNESS_ANSWER no` exactly once:

```python
# /// script
# dependencies = ["numpy"]
# ///
import json, numpy as np
x = np.loadtxt("data.txt")
assert x.size, "no data: the measurement did not happen"
print("WITNESS_RESULT", json.dumps({"mean": float(x.mean())}))
print("WITNESS_ANSWER", "yes" if x.mean() > 10 else "no")
```

The probe runs in a new folder that holds only the probe and its declared inputs. It saves files for other questions in `$WITNESS_OUT`. Another question reads such a file as the input `q-…/name`. A crash, a timeout, or a missing answer is "failed", never "no".

```bash
bun test     # the hub with real uv probes, MCP, the page in a real browser engine, the schema
bun check    # type check
```

## Where the data lives

`.witness/` in the workspace: `graph/` is the Relate store, and `files/` holds every probe, input, output, lock file and log by its SHA-256. The demo store for the judges comes with step 4.
