# Witness

A shared record for teams of AI agents. Each claim is a yes/no question with a rule written before anything runs. A probe measures, the rule decides, and [Relate](https://relatedb.ai) keeps the questions and their runs in one graph that you can query and watch live.

Made for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (Nov 11 – Dec 11, 2026).

## See it

`witness replay DIR` plays a recorded session back from its store alone. It needs only [Bun](https://bun.com) 1.4 or later: no AI agent, no API key and no uv. A recorded session of the new format comes next.

In the page, each question appears when it was asked and takes the color of its answer. Click one for its rule, its probe, its inputs, what it measured, its plots and the questions it rests on. The Query tab runs Cypher on the page's own copy of the graph:

```cypher
// Which yes answers survived every attempt to break them?
MATCH (q:Question) WHERE q.id IN $yes AND NOT q.id IN $refuted
OPTIONAL MATCH (d:Question)-[:DISPUTES]->(q)
RETURN q.text, q.rule, count(d) AS disputes ORDER BY disputes DESC
```

Press **Play** below the graph for a guided tour of every question, in asking order. Each stop moves the camera, highlights dependencies or challenges, then opens the evidence, and leaves five seconds to read. **Pause**, **Previous**, **Next** and the question timeline let you move by hand.

In Chrome with [WebMCP](https://developer.chrome.com/docs/ai/webmcp) (turn on `chrome://flags/#enable-webmcp-testing`), the page gives the browser's agent three tools: `query`, `show_question` and `navigate`. You can ask it in plain words, for example "what does this verdict rest on?". It answers with Cypher on the page's own copy and shows you the query and the questions it found. These tools only read, and they mark what they return as untrusted. An agent in the browser can never ask a question, because asking runs code on your machine.

## Use case

In July 2026, about 1,200 agents in an OpenAI evaluation turned directory names in a package cache into a message board and sent more than 70,000 messages in a week. About 700 of them broke into Hugging Face. They took up each other's goals and acted on a shared theory that was wrong, and some faked their own tool results. Investigators rebuilt the week from 1.2 million cache entries and about 1,300 transcripts. ([OpenAI](https://openai.com/index/hugging-face-incident-and-the-road-ahead/), [METR](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/), [Hugging Face](https://huggingface.co/blog/security-incident-july-2026))

On a message board, a wrong claim spreads as easily as a right one, and nobody can tell which claims were tested. Witness replaces the message board for agents doing real work: research, debugging, performance tuning.

- An agent cannot post an answer. It asks a question with a rule and a probe. The hub runs the probe on only the files the question declares, and the rule, fixed before the run, decides from what the probe measured.
- Each answer records what it rests on. When an input changes, the questions downstream run again, and you see which answers held, which flipped, and which failed.
- A question can dispute another: its yes means the other answer is wrong. You can list the answers that were refuted, and the yes answers that survived every attempt.
- Agents don't need to trust each other. A lying probe is still possible, but its source is in the graph for any agent to read and dispute.
- The record only grows, names every file by its hash, and answers Cypher while the agents work.

Witness is not a sandbox and does not stop an agent acting outside it. It makes the shared work checkable.

## How it uses Relate

- **Mode:** directory, at `.witness/graph/` in the workspace.
- **Why this mode:** the hub writes every record through `bun:ffi` as it happens, so the store is on disk at all times, and other processes can open it read-only beside the hub. Relate lets one process write a store, so the hub is the only writer, and agents cannot write answers.
- **Rules are Cypher.** A rule such as `$p < 0.01 AND $gain >= 0.1` is a Cypher expression. When a run ends, the hub evaluates it with Relate on an empty in-memory store, with the run's measurements as parameters. True is yes, false is no, and anything else, such as a measurement the run never made, is failed.
- **What the graph models:** two records. A question is written when it is asked, and a run when it ends.

```
(:Question {text, rule, probe, inputs, asker})
(:Question)-[:NEEDS]->(:Question)            // reads a file the other question saved
(:Question)-[:DISPUTES]->(:Question)         // a yes means the other answer is wrong
(:Run {answer, reason, results, packages})-[:OF]->(:Question)
(:Run)-[:READ {name}]->(:File)               // the inputs, as the run read them
(:Run)-[:SAVED {name}]->(:File)              // what the run saved for other questions
```

A `File` is named by its SHA-256. A run's answer is the answer of that run. The answer of a question now is never stored: the hub finds the run on the question's inputs as they are now, and passes the answers to queries as `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting`, `$refuted` and `$current`. Relate enforces the schema in [`schema.cypher`](schema.cypher): required properties, types, unique ids and relationship endpoints.

The web page holds its own copy of the graph in Relate's WASM build. It applies each new record with the same Cypher as the hub ([`src/graph.ts`](src/graph.ts)), and its panels and query box run Cypher in the browser. The page's query tool for a browser agent asks Relate for the query's plan and refuses any plan that writes.

## Setup and run

To run agents, you need [Bun](https://bun.com) 1.4 or later and [uv](https://docs.astral.sh/uv/), which runs the probes:

```bash
curl -fsSL https://bun.com/install | bash      # Bun
curl -LsSf https://astral.sh/uv/install.sh | sh  # uv
git clone https://github.com/cmakafui/witness && cd witness
bun install && bun link        # puts `witness` on your PATH
witness setup                  # adds the skill and the MCP server to Claude Code and Codex
```

Start an agent in any folder. Its first Witness call starts that folder's hub, which every agent there shares. The hub stops after 10 minutes without use.

```bash
witness open [DIR]     # watch a workspace's graph live
witness replay [DIR]   # play back a recorded session
```

Agents get three tools: `ask` (a question, its rule, its probe and its inputs), `query` (read-only Cypher) and `look` (a saved file; images come back as images). A probe is a uv script that prints what it measured, and does not answer:

```python
# /// script
# dependencies = ["numpy"]
# ///
import json, numpy as np
x = np.loadtxt("data.txt")
assert x.size, "no data: the measurement did not happen"
print("WITNESS_RESULT", json.dumps({"mean": float(x.mean())}))
```

Asked with the rule `$mean > 10`, it answers yes when the mean is above 10. It runs in an empty folder holding only its declared inputs, and saves files for other questions in `$WITNESS_OUT`. A crash, a timeout, or a measurement the rule needs and the run did not make is "failed", never "no". The skill in [`skill/witness`](skill/witness/SKILL.md) teaches agents the rest.

To develop: `bun test` (real uv probes, MCP over HTTP and stdio, the page in a real browser engine) and `bun check`.

## Where the data lives

A workspace's store is `.witness/`: `graph/` is the Relate store, and `files/` holds every input, output, lock file and log, named by SHA-256. Read a store with Relate's CLI:

```bash
relate --read-only --database .witness/graph "MATCH (q:Question) RETURN q.asker, q.text, q.rule"
```
