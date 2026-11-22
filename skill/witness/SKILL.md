---
name: witness
description: Use Witness to record findings as tested answers, not notes. Ask a yes/no question with a rule and a probe. The probe is a uv Python script that measures. The rule is a Cypher expression that decides yes or no from the measurements. Witness runs the probe on its declared files only, and runs the question again when a file changes. All agents in the workspace share the answers. Use when the witness MCP tools (goal, ask, query, look) are available, before you claim that something works or does not, and before you build on the result of another agent.
---

# Witness

No agent writes an answer. A probe measures; a Cypher rule decides.

## Steps

1. On a fresh store, start with the task. Use `query` when resuming, joining existing work, or looking for findings to build on.
2. For a new probe, draft it in `scratch/` and test on a small case (`uv run --script scratch/probe.py`). Try a package first with `uv run --with PACKAGE python -c '…'`. Neither is evidence; keep drafts out of `.witness/`.
3. Call `ask` with `text`, `rule`, `inputs`, and `asker` (your direction of work). Supply `probe` for a new script or `probe_ref: "q-…"` to reuse the exact script from an existing question. Save candidate outputs in `$WITNESS_OUT` (`q-…/name`) rather than overwriting a shared workspace file that probes read.
4. Read the answer, measurements, and saved files (`look`). Hand other agents question ids and `q-…/name` paths, not summaries.

## Change the form, render, look

A problem can take many forms: text, numbers, a matrix, a graph, an image, a sound, a spectrum. Each form shows what the others hide. PyPI has the packages of every field that works with a form, so a probe can move the evidence into any of them.

You read text and see images, so work in a closed loop:

1. A probe puts the data into a new form and renders it as a PNG in `$WITNESS_OUT`, beside what it measures.
2. `look` at the render (`q-…/name.png`). It comes back as an image, and it stays in the graph beside its question, where every agent and the person watching the page can see it.
3. Let what you see choose the next question. A picture prompts a question; it is not an answer. The next probe measures what the picture suggested, and declares the files it builds on (`q-…/name`) as inputs.

## Goals and acceptance

Goals are optional (`goal({text})`, `g-…`). Bind at most one acceptance question with `accepts: "g-…"` before it runs; only its current `yes` completes the goal. To replace a crashed acceptance question, create a new goal and ask with both `accepts` and `replaces`.

```cypher
MATCH (g:Goal)
OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id AS goal, g.text, g.id IN $complete AS complete, q.id AS acceptance
ORDER BY g.seq
```

## Probes and rules

Start from [assets/probe.py](assets/probe.py).

- **Probe:** PEP 723 `uv` script running in an isolated temp folder with only its declared `inputs`. Print `WITNESS_RESULT` + one JSON object per measurement (cast numpy scalars with `int()`/`float()`). Save outputs for other questions in `$WITNESS_OUT`. Never act (send/deploy) in a probe.
- **Dependencies:** If the probe installs packages, set a fixed `[tool.uv] exclude-newer = "YYYY-MM-DDTHH:MM:SSZ"` date (never a relative date).
- **Crashes & noise:** Stop with an error if measurement did not occur—a crash gives `failed`, not `no`, and leaves files unreadable. Fix a crashed probe with `replaces: "q-…"`. For noisy quantities, loop inside one probe and judge `$results`.
- **Rule:** One Cypher expression over `$name` (last value) and `$results` (all records): e.g. `$mean > 10` or `all(r IN $results WHERE r.error <= 0.3)`. Missing fields give `null` (`failed`), not `no`—handle with `coalesce(...)`.

## Querying and reporting

Relate Cypher gotchas: pass `$vars` via `params` (missing params error); `WITH` drops every variable it does not list, so list each one you use later (`WITH q, r, count(f) AS files`); bound traversals (`*0..5`) and `LIMIT 50`; no Neo4j/APOC procedures. Use `$current` for current runs and `WHERE q.id IN $failed AND NOT q.id IN $replaced` for open failures. Read `q.probe` from the graph, not `scratch/`.

The schema writes `{name}` for a property a relationship has. In a query, give it a value (`-[:NEEDS {name: 'q-…/file'}]->`) or leave it out. `NEEDS` has one edge per file, so a question that reads two files from one producer has two edges to it: walk `NEEDS` with `DISTINCT`.

```cypher
MATCH (q:Question)-[:NEEDS*0..5]->(u:Question)<-[:OF]-(r:Run)
WHERE r.id IN $current
RETURN DISTINCT q.id, u.id, r.answer, r.results LIMIT 50
```

Report question ids, answers, and goal completion first:

```
q-3f9a1c0b7e2d yes      the total is exact (2,000 cases)
q-81d0aa94c3f1 no       16 workers is not faster (ratio 0.98)
q-c02e5bd1a7a8 failed   the run did not measure p
```
