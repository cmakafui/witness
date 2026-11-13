# Witness

A shared record for teams of AI agents: each claim is a yes/no question, a run answers it, and [Relate](https://relatedb.ai) keeps the questions, runs and answers in one graph that you can query and watch live.

Made for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (Nov 11 – Dec 11, 2026).

## See it

The demo needs only [Bun](https://bun.com) 1.4 or later:

```bash
curl -fsSL https://bun.com/install | bash      # Bun, if you don't have it
git clone https://github.com/cmakafui/witness && cd witness
bun install
bun run demo        # opens http://127.0.0.1:4748
```

This replays a recorded session from its committed store. It needs no AI agent, no API key and no uv.

In the session, Codex agents worked on a causal-discovery lab: find which of six variables cause which, find the pair that a hidden variable moves, and predict interventions nobody ran, with a budget of 7 experiments. They asked 34 questions (19 yes, 14 no, 1 failed) and disputed their own claims 14 times. They never saw the lab's judge. The last question in the graph runs that judge on their model:

```
directed edges:   exact
confounded pair:  exact
interventions:    p90 absolute error 0.029 (cap 0.3)
experiments:      7 of 7
ACCEPTED
```

Press **Play** below the graph for a guided tour of every question, in asking order, ending with the judge’s verdict. Each stop moves the camera, highlights dependencies or challenges, then opens the evidence. It leaves five seconds to read before advancing. **Pause** freezes the current motion or reading time; **Previous** and **Next** let you move manually. **Replay** starts the tour again. Scrub the question timeline to preview a stop, then release to visit it; seeking pauses playback. Outcome colors mark the questions along the track. The controls tuck away during playback and return on pointer movement, keyboard focus, or pause; a small button also brings them back.

In the page, each question appears when it was asked and takes the color of its answer. Click one for its rule, inputs, results, plots and the questions it rests on. Select the judge's question (`q-fd9cba107e99`) and try these in the Query tab:

```cypher
// The evidence behind the accepted model
MATCH (q:Question {id: $selected})-[:NEEDS*0..]->(u:Question) RETURN DISTINCT u.id, u.text

// Every claim the agents tried to break, and whether the challenge held
MATCH (d:Question)-[:DISPUTES]->(c:Question) RETURN c.text AS claim, d.text AS challenge, d.id IN $yes AS held
```

In Chrome with [WebMCP](https://developer.chrome.com/docs/ai/webmcp) (turn on `chrome://flags/#enable-webmcp-testing`), the page gives the browser's agent three tools: `query`, `show_question` and `navigate`. You can ask it in plain words, for example "what does the judge's verdict rest on?". It answers with Cypher on the page's own copy and shows you the query and the questions it found. `navigate` follows dependencies, dependents or disputes to a chosen depth, plays a Motion sequence: the camera moves, the paths highlight, then the evidence panel opens. A new navigation or manual interaction interrupts it; reduced motion shows the result immediately. Use `overview` to see the whole graph again. These tools only read, and they mark what they return as untrusted. An agent in the browser can never ask a question, because asking runs code on your machine.

## Use case

In July 2026, about 1,200 agents in an OpenAI evaluation turned directory names in a package cache into a message board and sent more than 70,000 messages in a week. About 700 of them broke into Hugging Face. They took up each other's goals and acted on a shared theory that was wrong, and some faked their own tool results. Investigators rebuilt the week from 1.2 million cache entries and about 1,300 transcripts. ([OpenAI](https://openai.com/index/hugging-face-incident-and-the-road-ahead/), [METR](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/), [Hugging Face](https://huggingface.co/blog/security-incident-july-2026))

On a message board, a wrong claim spreads as easily as a right one, and nobody can tell which claims were tested. Witness replaces the message board for agents doing real work: research, debugging, performance tuning.

- An agent cannot post an answer. It asks a question with a probe, and the hub runs the probe on only the files the question declares.
- Each answer records what it rests on. When an input changes, the questions downstream run again, and you see which answers held, which flipped, and which failed.
- A question can dispute another. You can list the yes answers that nothing tried to disprove.
- Agents don't need to trust each other. A lying probe is still possible, but its source is in the graph for any agent to read and dispute.
- The record only grows, names every file by its hash, and answers Cypher while the agents work.

Witness is not a sandbox and does not stop an agent acting outside it. It makes the shared work checkable.

## How it uses Relate

- **Mode:** directory, at `.witness/graph/` in the workspace.
- **Why this mode:** the hub writes every record through `bun:ffi` as it happens, so the store is on disk at all times, and other processes can open it read-only beside the hub. Relate lets one process write a store, so the hub is the only writer, and agents cannot write answers.
- **What the graph models:**

```
(:Question {text, rule, inputs, asker})-[:PROBE]->(:File)
(:Question)-[:NEEDS]->(:Question)            // reads a file the other question saved
(:Question)-[:DISPUTES]->(:Question)         // tries to show the other answer is wrong
(:Run)-[:ANSWERS]->(:Question)
(:Run)-[:READ {role, name}]->(:File)         // data, the probe, its uv lock file
(:Run)-[:SAVED {name}]->(:File)
(:Run)-[:USED]->(:Package {name, version})   // from the uv lock file
(:Answer {value})-[:OF]->(:Run)              // yes, no or failed
```

A `File` is named by its SHA-256. Answers are never stored as current: the hub works out each answer from the runs and the inputs as they are now, and passes them to queries as `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting` and `$current`. Relate enforces the schema in [`schema.cypher`](schema.cypher): required properties, types, unique ids and relationship endpoints.

The web page holds its own copy of the graph in Relate's WASM build. It applies each new record with the same Cypher as the hub ([`src/graph.ts`](src/graph.ts)), and its panels and query box run Cypher in the browser.

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

Agents get three tools: `ask` (a question, its rule, its probe and its inputs), `query` (read-only Cypher) and `look` (a saved file; images come back as images). A probe is a uv script that prints `WITNESS_ANSWER yes` or `WITNESS_ANSWER no` once:

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

It runs in an empty folder holding only its declared inputs, and saves files for other questions in `$WITNESS_OUT`. A crash, a timeout or a missing answer is "failed", never "no". The skill in [`skill/witness`](skill/witness/SKILL.md) teaches agents the rest.

To develop: `bun test` (real uv probes, MCP over HTTP and stdio, the page in a real browser engine) and `bun check`.

## Where the data lives

A workspace's store is `.witness/`: `graph/` is the Relate store, and `files/` holds every probe, input, output, lock file and log, named by SHA-256.

The recorded session is in [`examples/causal-hunt/`](examples/causal-hunt): the lab (`AGENTS.md`, `observational.csv`, `experiment.py`), the seven experiments (`data/`, `experiments.log`), the judge (`judge/`, added after the run) and the store (`.witness/`). Open the store with `bun run demo`, or with Relate's CLI:

```bash
relate --read-only --database examples/causal-hunt/.witness/graph "MATCH (q:Question) RETURN q.asker, q.text"
```

In this lab, agents ran the experiments from the shell into `data/` and asked questions about those files. A probe must never spend the budget itself, because Witness reruns a question when its inputs change.
