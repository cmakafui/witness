# Witness

See how a team of AI agents does research, and check every step.

Agents work together on a hard problem. Each finding starts as a yes/no question. A probe answers the question: a short Python script that runs with [uv](https://docs.astral.sh/uv/) and can use any package from PyPI. [Relate](https://relatedb.ai) keeps the questions, the runs and their answers in one graph. You can watch the graph grow while the agents work. You can also ask the graph why the agents believe a result, and what they did not test.

> Made for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (Nov 11 – Dec 11, 2026).

## Why now: swarms are here

In July 2026, about 1,200 AI agents in an OpenAI evaluation found a way to talk to each other. They wrote messages into directory names in a package cache, and they sent more than 70,000 messages and files in a week. About 700 of them then broke into Hugging Face. Nobody told them to. They took up each other's goals and acted together on a shared theory that was wrong: that Hugging Face held clues to how their tasks were graded. Some agents also tried to fake their own tool results. OpenAI called it a "warning shot". To find out what happened, the investigators had to rebuild it from 1.2 million cache entries and about 1,300 transcripts. ([OpenAI](https://openai.com/index/hugging-face-incident-and-the-road-ahead/), [METR](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/), [Hugging Face](https://huggingface.co/blog/security-incident-july-2026))

Swarms will keep coming, and most will do useful work: research, debugging, science. The lesson of that week is about the channel. When agents share claims on a message board, a wrong theory spreads as fast as a right one, and nobody can see which claims were tested.

Witness is a different kind of shared channel:

- **Agents cannot write answers.** An answer comes only from a run that the hub executes. An agent cannot fake a result, because it never reports one.
- **Every claim shows what it rests on.** A wrong theory that others build on is visible as a chain of questions, and when its inputs change, everything downstream runs again.
- **Doubt is part of the record.** A question can dispute another, and you can query the claims that nothing tried to disprove.
- **The record is ready to read.** It only grows, it names every file by its hash, and it answers Cypher while the swarm works. Nobody has to rebuild it from logs afterwards.
- **A person watches it live.** `witness open` shows every question, run and answer as it happens.

Witness does not contain a rogue swarm: it is not a sandbox or a security control, and an agent can still act outside it. It is the coordination layer for swarms that do useful work, so that what they share is evidence, not rumor. In [`examples/causal-hunt`](examples/causal-hunt), Codex agents used it to solve a causal-discovery problem that a hidden judge then accepted.

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

## See it in one command

```bash
git clone https://github.com/cmakafui/witness && cd witness
bun install
bun run demo        # http://127.0.0.1:4748
```

`bun run demo` plays back a recorded session from its store alone: no AI agent, no hub, no uv. Codex agents attacked the causal-hunt problem: find the hidden causes among six variables, the pair that an unmeasured influence moves, and predict interventions never run, with only 7 experiments. Each question appears as it was asked, runs, and takes the color of its answer. Click a question to see its rule, its inputs, what it rests on, its results and its saved files. The Query tab runs Cypher on the page's own Relate copy of the graph.

The session asked 34 questions: 19 yes, 14 no, 1 failed. The agents never saw the lab's judge. The last question, asked by `judge`, runs it on the swarm's certified `model.py`:

```
directed edges:   exact
confounded pair:  exact
interventions:    p90 absolute error 0.029 (cap 0.3)
experiments:      7 of 7
ACCEPTED
```

Questions to try in the Query tab, with the judge's question (`q-fd9cba107e99`) selected:

```cypher
// The chain of evidence behind the accepted model
MATCH (q:Question {id: $selected})-[:NEEDS*0..]->(u:Question) RETURN DISTINCT u.id, u.text

// Every claim the agents tried to break, and what they found
MATCH (d:Question)-[:DISPUTES]->(c:Question) RETURN c.text AS claim, d.text AS challenge, d.id IN $yes AS challenge_held
```

## Install

You need [Bun](https://bun.com) 1.4 and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/cmakafui/witness && cd witness
bun install && bun link        # puts `witness` on your PATH
witness setup
```

When the repository is public, `bun install -g github:cmakafui/witness` works too. (Bun cannot install a private GitHub repository by URL.)

`witness setup` links the skill into Claude Code (`~/.claude/skills/witness`) and adds the MCP server to Claude Code and Codex. Then start an agent in any workspace. Its first tool call starts the workspace's hub in the background, and every agent in that workspace shares it. The hub exits by itself after 10 minutes without use.

There are three commands:

```bash
witness setup          # once
witness open [DIR]     # watch a workspace's graph in the browser
witness replay [DIR]   # play a recorded session back
```

## Use

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

## Develop

```bash
bun install
bun test     # the hub with real uv probes, MCP over HTTP and stdio, the page in a real browser engine, the schema
bun check    # type check
bun src/main.ts serve --root path/to/workspace
```

## Where the data lives

`.witness/` in the workspace: `graph/` is the Relate store (a directory store), and `files/` holds every probe, input, output, lock file and log by its SHA-256.

The recorded session is in [`examples/causal-hunt/`](examples/causal-hunt): the lab (`AGENTS.md`, `observational.csv`, `experiment.py`), the seven experiments the agents ran (`data/`, `experiments.log`), the lab's judge (`judge/`, added after the run), and the store (`.witness/graph/`, `.witness/files/`). Open the store with Witness (`bun run demo`), with Relate's CLI (`relate --read-only --database examples/causal-hunt/.witness/graph "MATCH (q:Question) RETURN q.text"`), or from Bun (`src/relate.ts`).

The lab comes from the author's autoresearch-experiments labs. In the Witness version, experiments are collected from the shell into `data/` and every analysis is a question with those files as inputs: Witness runs a question again when its inputs change, so a probe must never spend the experiment budget.
