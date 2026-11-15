# Witness

A shared record for teams of AI agents. Each claim is a yes/no question with a rule. The rule is written before anything runs. A probe measures. The rule decides. [Relate](https://relatedb.ai) keeps the questions and their runs in one graph. You can query the graph and watch it live. A goal states the solved condition. Its acceptance question determines whether it is complete; all other questions help find a solution without deciding completion.

Made for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (Nov 11 – Dec 11, 2026).

## See it

`witness replay DIR` opens a recorded session from its store alone. It needs only [Bun](https://bun.com) 1.4 or later. It needs no AI agent, no API key and no uv. It loads the whole recorded graph immediately and shows each question’s latest recorded run. Replay derives goal completion from those recorded answers; it does not check today’s workspace inputs.

Choose a goal to open its acceptance question, marked `◎`. Each row of the graph is one direction of work, and a curve joins a question to the questions that read its files. Select a question to see its evidence: the answer, each part of the rule with the values it used, saved images, files and run history. Drag the `seq` slider in the goal bar to step through recorded history. [`page/DESIGN.md`](page/DESIGN.md) describes the page in full.

At an earlier step, the goal dropdown, question links, Evidence and WebMCP all use that step. Rewinding before a selected question was asked clears its selection, hover preview and Back entries. An unrun consumer stays `waiting` until its producer has measured and saved the named input file; a crashed producer or a missing output does not make it `pending`. A measured run can supply files even when its rule answers `no` or `failed`. History shows committed runs; it does not reconstruct when probes were running. Moving the slider to the end returns to the latest view without running probes.

The Query drawer runs Cypher on the graph in the page:

```cypher
// Which questions answer yes?
MATCH (q:Question) WHERE q.id IN $yes
RETURN q.text, q.rule ORDER BY q.seq
```

Chrome with [WebMCP](https://developer.chrome.com/docs/ai/webmcp) gives the browser's agent two tools: `query` and `show_question`. Turn it on at `chrome://flags/#enable-webmcp-testing`. You can ask the agent in plain words, for example "what does this verdict rest on?". It answers with Cypher and shows you the query and the questions it found. Every query, yours or the agent's, runs on a throwaway copy of the graph, so no query can change what the page shows. The tools mark what they return as untrusted. A browser agent can never ask a question, because a question runs code on your machine.

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
- **Rules are Cypher.** A rule such as `$p < 0.01 AND $gain >= 0.1` is a Cypher expression. When a run ends, the hub evaluates the rule with Relate on an empty in-memory store that refuses writes, so a rule can read only the measurements. The run's measurements are the parameters. True is yes. False is no. Anything else is failed, for example when the run never made a measurement the rule needs.
- **Four node types, five relationship types.** Goals state solved conditions. Questions fix tests. Runs record executions. Files hold the inputs and saved evidence. The hub writes a question and its goal binding together, before execution, and a run once it ends.

```
(:Goal {id, text, seq})-[:ACCEPTED_BY]->(:Question)  // its only acceptance question
(:Question {text, rule, probe, inputs, asker})
(:Question)-[:NEEDS]->(:Question)            // reads a file the other question saved
(:Run {answer, reason, started, ms, results})-[:OF]->(:Question)
(:Run)-[:READ {name}]->(:File)               // the inputs, as the run read them
(:Run)-[:SAVED {name}]->(:File)              // what the run saved for other questions
```

A `File` is named by its SHA-256. The answer of a run is stored with that run. The answer of a question is never stored. The hub finds the run on the question's inputs as they are now. It passes the answers to queries as `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting` and `$current`. Relate enforces the schema in [`schema.cypher`](schema.cypher): required properties, types, unique ids and relationship endpoints.

Goals and acceptance bindings are immutable. A goal can start without an acceptance question: it is open and incomplete. Bind at most one acceptance question, before it runs. An identical retry reuses that question. A different contract requires a new goal, which may use the same text. A goal is complete only while its acceptance question currently answers `yes`; `no`, `failed`, `pending`, `running` and `waiting` all mean incomplete. Input changes can invalidate completion. Restoring inputs restores their most recent recorded answer and its derived completion. No other question votes. Queries get `$complete` and `$incomplete` as goal-id lists; completion is never stored.

The page holds its own copy of the graph in Relate's WASM build. It applies each new record with the same Cypher as the hub ([`src/graph.ts`](src/graph.ts)). Its panels and query box run Cypher in the browser. A query runs on a throwaway copy of that graph, so it cannot change what the page shows.

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
- `ask`: a question, its rule, its probe and its inputs. Add `accepts: "g-…"` to bind the goal’s acceptance question. `accepts` is part of identity and binds a separate acceptance question before execution; it cannot promote an existing run. `ask` then also returns that goal’s current completion. The same question asked again is the same question, and the first asker stays on it.
- `query`: read-only Cypher.
- `look`: a saved file. Images come back as images.

For example, create a goal with `goal({text: "The candidate is correct on the independent suite and at least twice as fast as baseline."})`. Search for candidates and measure them with ordinary `ask` calls. Then bind `ask({accepts: "g-…", ...})` with a rule such as `$correct AND $speedup >= 2`, declaring the candidate and suite as inputs. A failed candidate search does not prevent completion; the acceptance question decides it. Choose that contract before executing its test.

```cypher
MATCH (g:Goal)
OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id, g.text, g.id IN $complete AS complete, q.id AS acceptance
ORDER BY g.seq
```

To measure again, send the same `ask` with `rerun: true`. The question stays unchanged and a new Run is appended. The latest finished run on the current inputs gives the answer, even when it failed. A call for a question that is already queued or running joins that execution. Earlier runs and files remain.

The cache key covers the probe and declared input hashes, not the full environment. A probe that installs packages must set a fixed package upload cutoff with [`exclude-newer`](https://docs.astral.sh/uv/guides/scripts/#improving-reproducibility), keeping that cutoff in the hashed probe text. It does not lock Python or the full environment. A rerun measures again; it does not guarantee the same result.

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
