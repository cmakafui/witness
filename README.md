# Witness

Shared memory for a team of AI agents. Agents can't write answers into it. They can only ask questions. A probe measures, and a Cypher rule decides yes or no. When a file changes, every answer that depends on it runs again.

[![Witness: the demo video](docs/img/video.jpg)](https://youtu.be/tZHEkV7kkDk)

## Why

Today, agents share what they learn in markdown notes. One writes "the parser is fixed". Nothing checks it, and when the code changes, the note doesn't. With many agents on a hard problem, wrong notes spread.

## How it works

- **Ask, don't tell.** A question has a probe (a uv Python script), the files it reads, and a rule such as `$failures = 0 AND $coverage >= 0.9`. The rule is fixed before the probe runs.
- **Answers follow their inputs.** Each run records the files it read, by hash. Change a file and the questions that read it run again.
- **One graph.** Everything lives in one [Relate](https://relatedb.ai) store. Agents query it over MCP. The page loads the same graph in your browser with Relate WASM, and a browser agent can query it over WebMCP.

## See it


https://github.com/user-attachments/assets/8fadc3d7-fee3-4697-8d09-07a99034f33f


Agents in three lanes recover a flag from a QR code encrypted with bits a human typed as "random". They ask 11 questions in under 5 minutes. A search for repeats in the keystream says no. A control, a one-letter change to the flag, must fail the acceptance rule, and it does. The acceptance question confirms the flag's SHA-256.

```bash
witness replay examples/human-rng
```

Replay needs only Bun: no agent, no API key and no uv. [`prompt.md`](examples/human-rng/prompt.md) is the task the agents got.

## Install

You need [Bun](https://bun.com) 1.4+ and [uv](https://docs.astral.sh/uv/), which runs the probes.

```bash
git clone https://github.com/cmakafui/witness && cd witness
bun install && bun link
```

## Use it with your agents

```bash
witness setup         # adds the skill and MCP server to Claude Code, Codex, Pi and agy
witness open [DIR]    # watch a workspace's graph live
witness replay [DIR]  # read a recorded session
```

Agents get four tools: `goal`, `ask`, `query` and `look`.

## How it uses Relate

- **Mode:** directory. Each workspace keeps its store at `.witness/graph/`. The recorded example is [`examples/human-rng/.witness/graph/`](examples/human-rng/.witness/graph/).
- **Why:** the hub writes every record as it happens, so the graph is always on disk. The hub is the only writer, through `bun:ffi`. Agents, the CLI and replay open the same folder read-only.
- **Rules** are Cypher, evaluated by Relate on an empty in-memory store that refuses writes. The page loads the same graph into Relate WASM.
- **Search:** full-text indexes on each question's text, rule and probe, and on why runs failed. Before an agent asks, it searches for the words. A hit comes with its answer now, so a ruled-out direction stays ruled out.

```
(:Goal)-[:ACCEPTED_BY]->(:Question)<-[:OF]-(:Run)-[:READ|SAVED]->(:File)
(:Question)-[:NEEDS|REPLACES]->(:Question)
```

The [guide](docs/guide.md) covers the details. Made for the [Relate by Neo4j Hackathon](https://relate.devpost.com/). [Apache-2.0](LICENSE).
