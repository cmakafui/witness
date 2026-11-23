# Witness guide

The details behind the [README](../README.md).

## Reading the page

`witness replay DIR` opens a recorded session from its store alone. It needs no AI agent, no API key and no uv. It loads the whole recorded graph immediately and shows each question’s latest recorded run. Replay derives goal completion from those recorded answers. It does not check today’s workspace inputs. It also exposes a read-only `/mcp` endpoint (`query` and `look` only, never `goal` or `ask`) so scripts and external clients can inspect recorded stores with the same contract as a live hub.

Choose a goal to open its acceptance question, marked `◎`. Each row of the graph is one direction of work, and a curve joins a question to the questions that read its files. Select a question to see its evidence: the answer, each part of the rule with the values it used, saved images, files and run history. Drag the `seq` slider in the goal bar to step through recorded history. [`page/DESIGN.md`](../page/DESIGN.md) describes the page in full.

At an earlier step, the goal dropdown, question links, Evidence and WebMCP all use that step. Rewinding before a selected question was asked clears its selection, hover preview and Back entries. An unrun consumer stays `waiting` until its producer has measured and saved the named input file. A measured run can supply files even when its rule answers `no` or `failed`. History shows committed runs. It does not reconstruct when probes were running. Moving the slider to the end returns to the latest view without running probes.

Chrome with [WebMCP](https://developer.chrome.com/docs/ai/webmcp) gives the browser's agent two tools: `query` and `show_question`. Turn it on at `chrome://flags/#enable-webmcp-testing`. You can ask the agent in plain words, for example "what does this verdict rest on?". It answers with Cypher and shows you the query and the questions it found. Every query, yours or the agent's, runs on a throwaway copy of the graph, so no query can change what the page shows. The tools mark what they return as untrusted. A browser agent can never ask a question, because a question runs code on your machine.

## How it uses Relate

- **Mode:** directory, at `.witness/graph/` in the workspace.
- **Why this mode:** the hub writes every record through `bun:ffi` as it happens, so the store is always on disk. Other processes can open it read-only beside the hub. Relate lets only one process write to a store. The hub is that process. Agents cannot write answers.
- **Rules are Cypher.** A rule such as `$p < 0.01 AND $gain >= 0.1` is a Cypher expression. When a run ends, the hub evaluates the rule with Relate on an empty in-memory store that refuses writes, so a rule can read only the measurements. The run's measurements are the parameters. True is yes. False is no. Anything else is failed, for example when the run never made a measurement the rule needs.
- **Four node types, six relationship types.** Goals state solved conditions. Questions fix tests. Runs record executions. Files hold the inputs and saved evidence. The hub writes a question and its goal binding together, before execution, and a run once it ends.

```
(:Goal {id, text, seq, created})-[:ACCEPTED_BY]->(:Question)  // its only acceptance question
(:Question {text, rule, probe, inputs, asker, seq, created})
(:Question)-[:NEEDS {name}]->(:Question)     // reads a saved file (q-…/file) or recorded result (q-…, mounted as q-….json)
(:Question)-[:REPLACES]->(:Question)         // fixes a question whose run crashed or timed out
(:Run {answer, reason, started, ms, results})-[:OF]->(:Question)
(:Run)-[:READ {name}]->(:File)               // the inputs, as the run read them
(:Run)-[:SAVED {name}]->(:File)              // what the run saved for other questions
```

A `File` is named by its SHA-256. The answer of a run is stored with that run. The answer of a question is never stored. The hub finds the run on the question's inputs as they are now. It passes the answers to queries as `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting`, `$replaced` and `$current`. Relate enforces the schema in [`schema.cypher`](../schema.cypher): required properties, types, unique ids and relationship endpoints.

Goals and acceptance bindings are immutable. A goal can start without an acceptance question: it is open and incomplete. Bind at most one acceptance question, before it runs. An identical retry reuses that question. A different contract requires a new goal, which may use the same text. A goal is complete only while its acceptance question currently answers `yes`; `no`, `failed`, `pending`, `running` and `waiting` all mean incomplete. Input changes can invalidate completion. Restoring inputs restores their most recent recorded answer and its derived completion. No other question votes. Queries get `$complete` and `$incomplete` as goal-id lists; completion is never stored.

The page holds its own copy of the graph in Relate's WASM build. It applies each new record with the same Cypher as the hub ([`src/graph.ts`](../src/graph.ts)). Its panels and query box run Cypher in the browser. A query runs on a throwaway copy of that graph, so it cannot change what the page shows.

## Setup and run

To run agents, you need [Bun](https://bun.com) 1.4 or later and [uv](https://docs.astral.sh/uv/). uv runs the probes.

```bash
curl -fsSL https://bun.com/install | bash      # Bun
curl -LsSf https://astral.sh/uv/install.sh | sh  # uv
git clone https://github.com/cmakafui/witness && cd witness
bun install && bun link        # puts `witness` on your PATH
witness setup                  # adds the skill and the MCP server to Claude Code, Codex, Pi and agy
```

Start an agent in any folder. Its first Witness call starts the hub for that folder. Every agent in the folder shares that hub. The hub stops after 10 minutes without use. It runs one probe per CPU core at a time, and more asks wait in line. To change that, set `WITNESS_JOBS` in the environment that starts your agent: the hub it starts reads it. A probe can still start more threads than one, so a task prompt says how many each probe may use.

```bash
witness open [DIR]     # watch a workspace's graph live
witness replay [DIR]   # inspect a recorded session
```

Agents get four tools:

- `goal`: create a new immutable goal from its solved condition. When resuming, query to find an existing goal.
- `ask`: a question, its rule, its probe and its inputs. Give the script as `probe` or reuse an existing question’s script with `probe_ref: "q-…"`. The hub stores the resolved script so identical inline and referenced asks share one question and cached answer. Supply this question’s own inputs and rule. Add `accepts: "g-…"` to bind the goal’s acceptance question. `accepts` is part of identity and binds a separate acceptance question before execution; it cannot promote an existing run. `ask` then also returns that goal’s current completion. Add `replaces: "q-…"` when the question fixes the probe of a question whose run crashed or timed out. The hub refuses it for a question that measured: a yes, a no or a failed rule is evidence. The crashed question keeps its answer, and queries get it in `$replaced`. The same question asked again is the same question, and the first asker stays on it.
- `query`: read-only Cypher.
- `look`: a saved file. Images come back as images.

Each tool declares an output schema and returns structured content, so a client knows each result's shape before it calls. A code-mode client can then chain `query` and `look` in one program.

For example, create a goal with `goal({text: "The candidate is correct on the independent suite and at least twice as fast as baseline."})`. Search for candidates and measure them with ordinary `ask` calls. Then bind `ask({accepts: "g-…", ...})` with a rule such as `$correct AND $speedup >= 2`, declaring the candidate and suite as inputs. A failed candidate search does not prevent completion; the acceptance question decides it. Choose that contract before executing its test.

```cypher
MATCH (g:Goal)
OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id, g.text, g.id IN $complete AS complete, q.id AS acceptance
ORDER BY g.seq
```

A run that measured is final for its inputs: the same `ask` returns it. To measure again, change an input or ask a new question. A run that crashed or timed out settles nothing. The hub does not retry it on its own, but the same `ask` runs it again and appends a new Run. Asks for a question that is already queued or running join that execution. To measure a noisy quantity, loop inside the probe and let the rule judge the distribution.

The cache key covers the probe and declared input hashes, not the full environment. A probe that installs packages must set a fixed package upload cutoff with [`exclude-newer`](https://docs.astral.sh/uv/guides/scripts/#improving-reproducibility), keeping that cutoff in the hashed probe text. It does not lock Python or the full environment.

A probe is a uv script. It prints what it measured. It does not answer:

```python
# /// script
# dependencies = ["numpy"]
# [tool.uv]
# exclude-newer = "2026-11-14T00:00:00Z"
# ///
import json, numpy as np
x = np.loadtxt("data.txt")
assert x.size, "no data: the measurement did not happen"
print("WITNESS_RESULT", json.dumps({"mean": float(x.mean())}))
```

Asked with the rule `$mean > 10`, this probe answers yes when the mean is above 10. It runs in an empty folder that holds only its declared inputs. It saves files for other questions in `$WITNESS_OUT`. A crash, a timeout, or a missing measurement that the rule needs gives "failed". It never gives "no". The skill in [`skill/witness`](../skill/witness/SKILL.md) teaches agents the rest.

To set agents on a problem, start one in the problem's folder and give it your task: the problem, what counts as solved, and the rules. The skill carries the working method.

To develop, run `bun test` (real uv probes, MCP over HTTP and stdio, the page in a real browser engine) and `bun check`.

## Where the data lives

A workspace's store is `.witness/`. `graph/` is the Relate store. `files/` holds the inputs and saved outputs, named by SHA-256. A failed run records a short diagnostic tail in its reason, and names any file the probe tried to read through Python that it did not have: most often a file it needs but did not declare. Read a store with Relate's CLI:

```bash
relate --read-only --database .witness/graph "MATCH (q:Question) RETURN q.asker, q.text, q.rule"
```
