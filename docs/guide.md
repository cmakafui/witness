# Witness guide

The details behind the [README](../README.md).

## Setup

You need [Bun](https://bun.com) 1.4 or later and [uv](https://docs.astral.sh/uv/). uv runs the probes.

```bash
curl -fsSL https://bun.com/install | bash        # Bun
curl -LsSf https://astral.sh/uv/install.sh | sh  # uv
git clone https://github.com/cmakafui/witness && cd witness
bun install && bun link   # puts `witness` on your PATH
witness setup             # adds the skill and the MCP server to Claude Code, Codex, Pi and agy
```

Start an agent in any folder. Its first Witness call starts the hub for that folder, and every agent in the folder shares it. The hub stops after 10 minutes without use. It runs one probe per CPU core at the same time, and more asks wait in line. To change the number, set `WITNESS_JOBS` where you start the agent. A probe can start more threads than one, so say in the task how many each probe may use.

```bash
witness open [DIR]     # watch the graph of a workspace live
witness replay [DIR]   # read a recorded session
```

To set agents on a problem, start one in the folder of the problem and give it the task: the problem, what counts as solved, and the rules. The skill teaches the working method.

## The tools

- `goal`: make a goal that states a solved condition. A goal does not change.
- `ask`: a question, its rule, its probe and its inputs. `probe_ref: "q-…"` uses the probe of another question. `accepts: "g-…"` makes the question the acceptance question of a goal, before it runs. `replaces: "q-…"` fixes the probe of a question whose run did not measure (crashed or timed out). `lane` names the direction of work.
- `query`: read-only Cypher.
- `look`: a saved file. Images come back as images.
- `watch`: waits for new questions and run answers in a lane. Give its `cursor` back as `after` to get the next ones.

Each tool declares an output schema and returns structured content, so a code-mode client can chain calls in one program.

## Questions and answers

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

With the rule `$mean > 10`, this question answers yes when the mean is above 10. The probe runs in an empty folder that holds only its declared inputs. It saves files for other questions in `$WITNESS_OUT`. A crash, a timeout, or a missing measurement that the rule needs gives `failed`, never `no`.

The hub evaluates the rule with Relate, on an empty in-memory store that refuses writes. The measurements are the parameters. True is yes, false is no, and anything else is failed.

A question is the same question when its text, rule, probe, inputs, goal and the question it replaces are the same. Ask it again and you get its answer on the inputs as they are now:

- A run that measured is final for its inputs. To measure again, change an input or ask a new question.
- A run that did not measure settles nothing. The same ask runs it again. Concurrent asks join one run.
- When an input changes, the question runs again. When the inputs change back, their recorded answer comes back. So a probe must never act: it must not send or deploy.
- To measure a noisy quantity, loop inside the probe and let the rule judge `$results`.

The run key covers the probe text and the hashes of the declared inputs, not the whole environment. A probe that installs packages must fix a package upload cutoff with [`exclude-newer`](https://docs.astral.sh/uv/guides/scripts/#improving-reproducibility). The cutoff is in the probe text, so it is in the key.

A goal is complete only while its acceptance question answers yes now. A goal with no acceptance question is open. Completion is never stored: queries get it as `$complete`. To change the test of a goal, make a new goal.

For example, make the goal "The candidate is correct on the independent suite and at least twice as fast as the baseline." Search with ordinary questions. Then ask with `accepts: "g-…"`, the rule `$correct AND $speedup >= 2`, and the candidate and the suite as inputs. A failed search does not block completion. Only the acceptance question decides it.

## The graph

The store is one [Relate](https://relatedb.ai) directory at `.witness/graph/`. The hub writes every record through `bun:ffi` as it happens. It is the only writer, and it only creates. Other processes open the store read-only. `.witness/files/` keeps the inputs and saved outputs, each named by its SHA-256.

```
(:Goal {id, text, seq, created})-[:ACCEPTED_BY]->(:Question)
(:Question {id, text, rule, probe, inputs, lane, timeout, seq, created})
(:Question)-[:NEEDS {name}]->(:Question)     // reads a saved file (q-…/file) or a recorded result (q-…)
(:Question)-[:REPLACES]->(:Question)         // fixes a question whose run did not measure
(:Run {id, key, seq, started, ms, answer, reason, measured, results, last})-[:OF]->(:Question)
(:Run)-[:READ {name}]->(:File {id})          // the inputs, as the run read them
(:Run)-[:SAVED {name}]->(:File)              // what the run saved for other questions
```

The answer of a run is stored with the run. The answer of a question is never stored: the hub finds the run on the inputs of the question as they are now. Queries get the answers as `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting`, `$replaced`, `$current` and `$complete`. Relate enforces the schema in [`schema.cypher`](../schema.cypher).

Two full-text indexes find earlier work by its words. `question_text` covers the text, rule and probe of each question. `run_reason` covers why each run failed. A search runs next to the answer parameters, so each match comes with its answer now.

A failed run records a short tail of its output. It also names the files that the probe tried to read through Python but did not declare.

Read a store with the Relate CLI:

```bash
relate --read-only --database .witness/graph "MATCH (q:Question) RETURN q.lane, q.text, q.rule"
```

## The page

`witness open` shows the live graph. `witness replay DIR` shows a recorded session from its store alone. Replay needs no agent, no API key and no uv. It shows the latest recorded run of each question and does not check the workspace files. It also serves a read-only `/mcp` with `query` and `look`.

- Choose a goal to open its acceptance question, marked `◎`.
- Each row is one lane. A curve joins a question to each question that reads its files.
- Select a question to see its evidence: the answer, each part of the rule with its values, saved images, files and runs.
- Drag the `seq` slider to step through the recorded order. Everything on the page uses that step. A question that waits for a file stays `waiting` until its producer measured and saved that file. The end of the slider returns to the live view.
- A running question has a Cancel button. Its run then did not measure, and the next ask runs it again. Only the page can cancel.

The page holds its own copy of the graph in Relate WASM and applies each new record with the same Cypher as the hub ([`src/graph.ts`](../src/graph.ts)). Every query runs on a throwaway copy, so no query can change what the page shows.

In Chrome with [WebMCP](https://developer.chrome.com/docs/ai/webmcp) (`chrome://flags/#enable-webmcp-testing`), the browser's agent gets two tools: `query` and `show_question`. Ask it in plain words, for example "what does this answer depend on?". It answers with Cypher and shows the questions it found. The tools mark what they return as untrusted. A browser agent can never ask a question, because a question runs code on your machine.

[`page/DESIGN.md`](../page/DESIGN.md) describes the page in full.

## Develop

Run `bun test` (real uv probes, MCP over HTTP and stdio, the page in a real browser engine) and `bun check`.
