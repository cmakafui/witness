# Witness

A shared record for teams of AI agents. Each claim is a yes/no question with a rule. The rule is written before anything runs. A probe measures. The rule decides. [Relate](https://relatedb.ai) keeps the questions and their runs in one graph. You can query the graph and watch it live. A goal states the solved condition. Its acceptance question determines whether it is complete; exploratory questions help find a solution without deciding completion.

Made for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (Nov 11 – Dec 11, 2026).

## See it

`witness replay DIR` opens a recorded session from its store alone. It needs only [Bun](https://bun.com) 1.4 or later. It needs no AI agent, no API key and no uv. It loads the whole recorded graph immediately and shows each question’s latest recorded run. Replay derives goal completion from those recorded answers; it does not check today’s workspace inputs.

Choose a goal from the dropdown to open its acceptance question. A goal without an acceptance question shows “No acceptance question”. The graph highlights the selected question’s upstream artifact dependencies and keeps surrounding exploration visible, marking acceptance questions with a ringed glyph (`◎`). Each row is one direction of work; parallel questions share columns while preserving lane and dependency order, and hovering or arrowing across dots previews each question in a steady bar above the lanes.

The evidence panel stays open on the right, showing the selected question’s answer, actual rule clauses and their values, saved images, any extra measurements not already displayed in the clauses, files, and disclosures for the probe and run history. Measurement names and values come directly from the current committed run, without inferred labels, units or rounding. Multiple result records can be expanded under All measurements. Files distinguish declared inputs from saved outputs; input links open the archived bytes that the displayed run read. Pending work shows no old measurements as current. The Query drawer below the lanes runs Cypher on the page's own copy of the graph while keeping Evidence open:

```cypher
// Which questions answer yes?
MATCH (q:Question) WHERE q.id IN $yes
RETURN q.text, q.rule ORDER BY q.seq
```

Choose All questions for the whole record. Start from a goal’s acceptance question, hover upstream dots to preview how the work got there, or follow **Depends on** and **Used by** to inspect evidence in full. Click any question in the graph to inspect it, and use **Back** to return to the previous reading position. The Query drawer can list questions and runs by `seq` when you need their recorded order.

Chrome with [WebMCP](https://developer.chrome.com/docs/ai/webmcp) gives the browser's agent two tools: `query` and `show_question`. Turn it on at `chrome://flags/#enable-webmcp-testing`. You can ask the agent in plain words, for example "what does this verdict rest on?". It answers with Cypher on the page's copy of the graph. It shows you the query and the questions it found. Selecting a question through the graph, a link or `show_question` uses the same upstream highlight; Back restores the previous question and reading position. These tools only read, and they mark what they return as untrusted. A browser agent can never ask a question, because a question runs code on your machine.

## Use case

In July 2026, about 1,200 agents in an OpenAI evaluation turned directory names in a package cache into a message board. They sent more than 70,000 messages in a week. About 700 of them broke into Hugging Face. They took up each other's goals and acted on a shared theory that was wrong. Some faked their own tool results. Investigators rebuilt the week from 1.2 million cache entries and about 1,300 transcripts. ([OpenAI](https://openai.com/index/hugging-face-incident-and-the-road-ahead/), [METR](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/), [Hugging Face](https://huggingface.co/blog/security-incident-july-2026))

On a message board, a wrong claim spreads as easily as a right one. Nobody can tell which claims were tested. Witness replaces the message board for agents that do real work, such as research, debugging and performance tuning.

- An agent cannot post an answer. It asks a question with a rule and a probe. The hub runs the probe on only the files the question declares. The rule was fixed before the run. It decides from what the probe measured.
- Each answer records what it rests on. When an input changes, the questions downstream run again. You see which answers held, which flipped and which failed.
- Each probe’s source is in the graph. Any agent can inspect it and independently check its saved artifacts.
- The record only grows. It names every file by its hash. It answers Cypher while the agents work.

Witness is not a sandbox. It does not stop an agent from acting outside it. It makes the shared work checkable.

## How it uses Relate

- **Mode:** directory, at `.witness/graph/` in the workspace.
- **Why this mode:** the hub writes every record through `bun:ffi` as it happens, so the store is always on disk. Other processes can open it read-only beside the hub. Relate lets only one process write to a store. The hub is that process. Agents cannot write answers.
- **Rules are Cypher.** A rule such as `$p < 0.01 AND $gain >= 0.1` is a Cypher expression. When a run ends, the hub evaluates the rule with Relate on an empty in-memory store. The run's measurements are the parameters. True is yes. False is no. Anything else is failed, for example when the run never made a measurement the rule needs.
- **Four node types, six relationship types.** Goals state solved conditions. Questions fix tests. Runs record executions. Files hold the inputs and saved evidence. The hub writes a question and its goal binding together, before execution, and a run once it ends.

```
(:Goal {id, text, seq})-[:ACCEPTED_BY]->(:Question)  // its only acceptance question
(:Question)-[:FOR]->(:Goal)                        // exploratory purpose; never votes
(:Question {text, rule, probe, inputs, asker})
(:Question)-[:NEEDS]->(:Question)            // reads a file the other question saved
(:Run {answer, reason, started, ms, results})-[:OF]->(:Question)
(:Run)-[:READ {name}]->(:File)               // the inputs, as the run read them
(:Run)-[:SAVED {name}]->(:File)              // what the run saved for other questions
```

A `File` is named by its SHA-256. The answer of a run is stored with that run. The answer of a question is never stored. The hub finds the run on the question's inputs as they are now. It passes the answers to queries as `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting` and `$current`. Relate enforces the schema in [`schema.cypher`](schema.cypher): required properties, types, unique ids and relationship endpoints.

Goals and acceptance bindings are immutable. Exploratory `FOR` associations can be added to an existing question; one question may serve several goals. A goal can start without an acceptance question: it is open and incomplete. Bind at most one acceptance question, before it runs. An identical retry reuses that question. A different contract requires a new goal, which may use the same text. A goal is complete only while its acceptance question currently answers `yes`; `no`, `failed`, `pending`, `running` and `waiting` all mean incomplete. Input changes can invalidate completion. Restoring inputs restores their most recent recorded answer and its derived completion. Exploratory answers never vote. Queries get `$complete` and `$incomplete` as goal-id lists; completion is never stored.

The page holds its own copy of the graph in Relate's WASM build. It applies each new record with the same Cypher as the hub ([`src/graph.ts`](src/graph.ts)). Its panels and query box run Cypher in the browser. The page's query tool for a browser agent asks Relate for the plan of the query. It refuses any plan that writes.

## Setup and run

To run agents, you need [Bun](https://bun.com) 1.4 or later and [uv](https://docs.astral.sh/uv/). uv runs the probes.

```bash
curl -fsSL https://bun.com/install | bash      # Bun
curl -LsSf https://astral.sh/uv/install.sh | sh  # uv
git clone https://github.com/cmakafui/witness && cd witness
bun install && bun link        # puts `witness` on your PATH
witness setup                  # adds the skill and the MCP server to Claude Code and Codex
```

Start an agent in any folder. Its first Witness call starts the hub for that folder. Every agent in the folder shares that hub. The hub stops after 10 minutes without use.

```bash
witness open [DIR]     # watch a workspace's graph live
witness replay [DIR]   # inspect a recorded session
```

Agents get four tools:

- `goal`: create a new immutable goal from its solved condition. Query first to reuse a goal.
- `ask`: a question, its rule, its probe and its inputs. Add `goal: "g-…"` for exploration, or `accepts: "g-…"` to bind the acceptance question. These fields are mutually exclusive. Exploratory `goal` associations do not affect question identity: adding another goal reuses the question and its runs, including an execution already in progress. The first asker stays on the original question. `accepts` is part of identity and binds a separate acceptance question before execution; it cannot promote an existing exploratory run. `ask` also returns the associated goal’s current completion.
- `query`: read-only Cypher.
- `look`: a saved file. Images come back as images.

For example, create a goal with `goal({text: "The candidate is correct on the independent suite and at least twice as fast as baseline."})`. Associate candidate searches and measurements with `ask({goal: "g-…", ...})`. Then bind `ask({accepts: "g-…", ...})` with a rule such as `$correct AND $speedup >= 2`, declaring the candidate and suite as inputs. A failed candidate search does not prevent completion; the acceptance question decides it. Choose that contract before executing its test.

```cypher
MATCH (g:Goal)
OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id, g.text, g.id IN $complete AS complete, q.id AS acceptance
ORDER BY g.seq
```

To measure again, send the same `ask` arguments with `rerun: true`. Keep the text, rule, probe, inputs and acceptance binding the same. The question stays unchanged and a new Run is appended, even for unchanged inputs or a cached failure. Ordinary asks then reuse the latest finished run on those inputs, including a failed result. Previous runs and files remain available. A rerun of a shared exploratory question is shared across its goals.

If the question is already queued or running, the call joins that execution. To request another measurement, wait for it to finish before calling again. Reruns use the normal worker limit and wait for upstream inputs. On a new question, `rerun: true` simply requests its first execution. `wait_s: 0` returns immediately while queued or running work continues.

The live page shows pending, running or waiting until the new run finishes; an acceptance goal is incomplete during that time. Consumers rerun automatically when saved input bytes change, and reuse their cached runs when the bytes stay the same. Replay retains every run and displays the latest recorded execution. The cache key covers the probe and declared input hashes, not the full environment. A probe that installs packages must set a fixed package upload cutoff with [`exclude-newer`](https://docs.astral.sh/uv/guides/scripts/#improving-reproducibility), keeping that cutoff in the hashed probe text. It does not lock Python or the full environment; explicit rerun permits remeasurement, not a reproducibility guarantee.

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

Asked with the rule `$mean > 10`, this probe answers yes when the mean is above 10. It runs in an empty folder that holds only its declared inputs. It saves files for other questions in `$WITNESS_OUT`. A crash, a timeout, or a missing measurement that the rule needs gives "failed". It never gives "no". The skill in [`skill/witness`](skill/witness/SKILL.md) teaches agents the rest.

To set agents on a problem, start one in the problem's folder. Paste the prompt in [`method/prompt.md`](method/prompt.md).

To develop, run `bun test` (real uv probes, MCP over HTTP and stdio, the page in a real browser engine) and `bun check`.

## Where the data lives

A workspace's store is `.witness/`. `graph/` is the Relate store. `files/` holds the inputs and saved outputs, named by SHA-256. A failed run records a short diagnostic tail in its reason. Read a store with Relate's CLI:

```bash
relate --read-only --database .witness/graph "MATCH (q:Question) RETURN q.asker, q.text, q.rule"
```
