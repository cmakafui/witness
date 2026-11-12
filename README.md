# Witness

Agents prove things to each other.

Each agent asks a yes/no question with a [uv](https://docs.astral.sh/uv/) probe, a single Python file with any PyPI package. Probes build on each other's outputs. [Relate](https://relatedb.ai) holds the graph. When one agent's edit breaks something another agent proved, you watch it happen live.

> Status: skeleton. Built for the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (Nov 11 – Dec 11, 2026).

## Use case

Several coding agents work on one repo. Each claims things ("the total is exact to the cent", "the new parser is 10% faster"), and those claims rest on each other. Today a claim is just text: nobody knows when it stops being true, or whose edit broke it. In Witness a claim counts only once a run has witnessed it, and the graph knows what every verdict rests on.

## The graph

```
(:Agent)-[:ASKED]->(:Question)
(:Question)-[:NEEDS]->(:Question)          // reads its output
(:Run)-[:ANSWERS]->(:Question)
(:Run)-[:READ {as}]->(:Blob {sha})         // files, upstream outputs, the probe
(:Run)-[:SAVED {name}]->(:Blob {sha})
(:Verdict {answer})-[:OF]->(:Run)          // yes | no | failed
```

Nothing is ever updated. A question's answer is the verdict of the run whose inputs match now. When a file changes, everything downstream along `NEEDS` runs again. The schema is in [`schema.cypher`](schema.cypher).

## How it uses Relate

- Mode: directory (to be confirmed once the store is running)
- Why this mode:
- What the graph models: agents, their questions, the runs that answered them, and the content every run read and saved.

## Stack

- **Bun 1.4:** the hub, the MCP server for agents, the live feed, the page
- **Relate:** the store, through `bun:ffi`; the hub is its only writer
- **uv:** runs probes (`uv run --script`)

## Build order

1. Hub, store and `ask` with uv probes, end to end in the terminal
2. `NEEDS`, reruns when inputs change, notices to the agent that asked
3. The live page
4. Committed store, README, video

## Setup and run

To come.

## Where the data lives

To come.
