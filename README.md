# Witness

A shared record for teams of AI agents. Each claim is a yes/no question with a rule. The rule is written before anything runs. A probe measures. The rule decides. [Relate](https://relatedb.ai) keeps the questions and their runs in one graph. You can query the graph and watch it live.

Made for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (Nov 11 – Dec 11, 2026).

## See it

`witness replay DIR` plays a recorded session from its store alone. It needs only [Bun](https://bun.com) 1.4 or later. It needs no AI agent, no API key and no uv.

In the page, each question appears when it was asked. It takes the color of its answer. Click a question to see its rule, probe, inputs, measurements, plots and the questions it rests on. The Query tab runs Cypher on the page's own copy of the graph:

```cypher
// Which yes answers survived every attempt to break them?
MATCH (q:Question) WHERE q.id IN $yes AND NOT q.id IN $refuted
OPTIONAL MATCH (d:Question)-[:DISPUTES]->(q)
RETURN q.text, q.rule, count(d) AS disputes ORDER BY disputes DESC
```

Press **Play** below the graph for a guided tour of every question, in the order asked. Each stop moves the camera, highlights dependencies or challenges, and opens the evidence. You get five seconds to read each result. **Pause**, **Previous**, **Next** and the question timeline let you move by hand.

Chrome with [WebMCP](https://developer.chrome.com/docs/ai/webmcp) gives the browser's agent three tools: `query`, `show_question` and `navigate`. Turn it on at `chrome://flags/#enable-webmcp-testing`. You can ask the agent in plain words, for example "what does this verdict rest on?". It answers with Cypher on the page's copy of the graph. It shows you the query and the questions it found. These tools only read, and they mark what they return as untrusted. A browser agent can never ask a question, because a question runs code on your machine.

## Use case

In July 2026, about 1,200 agents in an OpenAI evaluation turned directory names in a package cache into a message board. They sent more than 70,000 messages in a week. About 700 of them broke into Hugging Face. They took up each other's goals and acted on a shared theory that was wrong. Some faked their own tool results. Investigators rebuilt the week from 1.2 million cache entries and about 1,300 transcripts. ([OpenAI](https://openai.com/index/hugging-face-incident-and-the-road-ahead/), [METR](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/), [Hugging Face](https://huggingface.co/blog/security-incident-july-2026))

On a message board, a wrong claim spreads as easily as a right one. Nobody can tell which claims were tested. Witness replaces the message board for agents that do real work, such as research, debugging and performance tuning.

- An agent cannot post an answer. It asks a question with a rule and a probe. The hub runs the probe on only the files the question declares. The rule was fixed before the run. It decides from what the probe measured.
- Each answer records what it rests on. When an input changes, the questions downstream run again. You see which answers held, which flipped and which failed.
- A question can dispute another question. Its yes means the other answer is wrong. You can list the refuted answers, and the yes answers that survived every attempt to refute them.
- Agents do not need to trust each other. A probe can still lie, but its source is in the graph. Any agent can read it and dispute it.
- The record only grows. It names every file by its hash. It answers Cypher while the agents work.

Witness is not a sandbox. It does not stop an agent from acting outside it. It makes the shared work checkable.

## How it uses Relate

- **Mode:** directory, at `.witness/graph/` in the workspace.
- **Why this mode:** the hub writes every record through `bun:ffi` as it happens, so the store is always on disk. Other processes can open it read-only beside the hub. Relate lets only one process write to a store. The hub is that process. Agents cannot write answers.
- **Rules are Cypher.** A rule such as `$p < 0.01 AND $gain >= 0.1` is a Cypher expression. When a run ends, the hub evaluates the rule with Relate on an empty in-memory store. The run's measurements are the parameters. True is yes. False is no. Anything else is failed, for example when the run never made a measurement the rule needs.
- **The graph has two records.** The hub writes a question when it is asked, and a run when it ends.

```
(:Question {text, rule, probe, inputs, asker})
(:Question)-[:NEEDS]->(:Question)            // reads a file the other question saved
(:Question)-[:DISPUTES]->(:Question)         // a yes means the other answer is wrong
(:Run {answer, reason, started, ms, results, packages})-[:OF]->(:Question)
(:Run)-[:READ {name}]->(:File)               // the inputs, as the run read them
(:Run)-[:SAVED {name}]->(:File)              // what the run saved for other questions
```

A `File` is named by its SHA-256. The answer of a run is stored with that run. The answer of a question is never stored. The hub finds the run on the question's inputs as they are now. It passes the answers to queries as `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting`, `$refuted` and `$current`. Relate enforces the schema in [`schema.cypher`](schema.cypher): required properties, types, unique ids and relationship endpoints.

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
witness replay [DIR]   # play back a recorded session
```

Agents get three tools:

- `ask`: a question, its rule, its probe and its inputs.
- `query`: read-only Cypher.
- `look`: a saved file. Images come back as images.

A probe is a uv script. It prints what it measured. It does not answer:

```python
# /// script
# dependencies = ["numpy"]
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

A workspace's store is `.witness/`. `graph/` is the Relate store. `files/` holds every input, output, lock file and log, named by SHA-256. Read a store with Relate's CLI:

```bash
relate --read-only --database .witness/graph "MATCH (q:Question) RETURN q.asker, q.text, q.rule"
```
