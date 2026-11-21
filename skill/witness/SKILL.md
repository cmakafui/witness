---
name: witness
description: Use Witness to record findings as tested answers, not notes. Ask a yes/no question with a rule and a probe. The probe is a uv Python script that measures. The rule is a Cypher expression that decides yes or no from the measurements. Witness runs the probe on its declared files only, and runs the question again when a file changes. All agents in the workspace share the answers. Use when the witness MCP tools (goal, ask, query, look) are available, before you claim that something works or does not, and before you build on the result of another agent.
---

# Witness

Witness keeps the tested answers of all agents in this workspace in one graph. No agent writes an answer. The probe measures. The rule decides.

| Term | Meaning |
|---|---|
| **Goal** | An immutable solved condition. Complete only while its one acceptance question currently answers yes. |
| **Question** | One yes/no question, with its rule, probe and inputs. You cannot edit a question. A changed question is a new question. |
| **Rule** | A Cypher expression over the measurements. True gives yes. False gives no. |
| **Probe** | A Python script that uv runs. It prints measurements. It does not give an answer. |
| **Input** | A file that the probe reads: a workspace path, or `q-…/name` for a file that another question saved. |
| **Run** | One execution of the probe: the measurements, the answer, and the files read and saved. |
| **Answer** | `yes`, `no` or `failed`. `pending`: an input changed, and the question runs again. `waiting`: a question that it reads has no answer yet, or its probe did not measure. |

## Steps

1. On a fresh store, start with the task. Use `query` when resuming, joining existing work, or looking for findings to build on.
2. For a new probe, draft it in `scratch/` and test it yourself on a small case: `uv run --script scratch/probe.py`. This shows that the probe works. It is not evidence. Keep drafts out of `.witness/`: only the hub writes there.
3. Call `ask` with the question, the rule and all inputs. Supply `probe` for a new script or `probe_ref: "q-…"` to reuse the exact script from an existing question. Give `asker` your direction of work. The page gives each direction its own row.
4. Read the answer, the measurements and the saved files.

## Working with other agents

The graph is the only record that agents share.

- When joining existing work, query for questions that may have answered yours or ruled out an approach.
- A finding exists for another agent only as a question id. Hand over question ids and saved files, not summaries.
- Before you build on a result, read its question: the rule, the probe, the inputs and the current answer.
- Give `asker` your direction of work. Witness does not record agents.

## Goals and acceptance

A goal is optional. Use one where the work needs a stopping condition: one for the whole task, one for each part, or none while you explore. Any agent can create a goal.

When resuming, use `query` to find an existing goal. `goal({text: "…"})` creates a new goal every time, even for identical text. Its id starts with `g-`. An unbound goal is open and incomplete.

- Use `ask` with `accepts: "g-…"` for the goal’s acceptance question. Leave it out for every other question. Those answers never determine completion, whether yes, no or failed.
- Write the acceptance contract before executing it. Witness writes the question and binding atomically before the probe starts. You can bind only one acceptance question per goal. An identical retry is allowed; a different contract requires a new goal.
- Acceptance binding is part of identity. `accepts` creates a distinct question bound before execution; an existing run cannot be promoted in place.
- Only the acceptance question’s **current** yes completes the goal. No, failed, pending, running and waiting all mean incomplete. Input changes invalidate completion; restoring the inputs restores their latest recorded answer. Completion is never stored.
- An `ask` with `accepts` returns the goal’s completion alongside the question’s answer. Query `$complete` and `$incomplete` for goal ids.

An acceptance question can read a candidate file directly or consume `q-…/name`. Its rule tests the solved condition. Exploration can keep producing negative answers while the goal is complete.

An acceptance question can read a file that another acceptance question saved. That link carries files, not completion: a run that measured and answered no still supplies its files. If one goal requires the result of another, check that result in the probe and the rule.

```cypher
MATCH (g:Goal)
OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id AS goal, g.text, g.id IN $complete AS complete, q.id AS acceptance
ORDER BY g.seq
```

## Asking again

- A run that measured is final for its inputs. The same `ask` returns it, whether the answer is yes, no or failed. To measure again, change an input or ask a new question.
- A run that crashed or timed out settles nothing. Send the same `ask` arguments to retry it. Keep the text, rule, probe, inputs and `accepts` unchanged. Witness does not retry on its own.
- A run that crashed because the probe was wrong: fix the probe and ask with `replaces: "q-…"`, the crashed question's id. The crashed question stays `failed` and goes into `$replaced`, so it no longer looks like an open problem. Witness refuses `replaces` for a question that measured, whether yes, no or a rule that failed: that is evidence. To dispute it, ask a new question beside it.
- To replace a goal's crashed acceptance question, create a new goal and ask the fix with both `accepts` (the new goal) and `replaces`.
- A call for a question already queued or running joins that execution.
- To measure a noisy quantity, do not ask again. Loop inside the probe, print each trial, and write the rule over `$results`.

## The rule

Write the rule before the probe runs.

- `$name` is the last measurement with that name.
- `$results` is the list of all measurements, in order: `all(r IN $results WHERE r.error <= 0.3)`.
- You can use comparisons, `AND`, `OR`, `NOT` and Cypher functions such as `abs()`, `all()`, `any()` and `size()`.
- The answer is `failed` if the rule names a measurement that the run did not print, if a value is null, or if the result is not true or false.
- A row without a field gives null, and null is not no. Say in the rule what a missing field means: `any(r IN $rows WHERE coalesce(r.error, 1.0) < 0.3)`.
- If the probe measured but the rule could not decide, other questions can still read the files that the run saved. Files of a crash or a timeout cannot be read.
- A rule is one expression. Witness evaluates it on an empty store that refuses writes, so a rule can read only the measurements.

## The probe

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.3.4"]
# [tool.uv]
# exclude-newer = "2026-11-14T00:00:00Z"
# ///
import json, os
import numpy as np

x = np.loadtxt("data.txt")
assert x.size, "no data"
np.save(os.path.join(os.environ["WITNESS_OUT"], "x.npy"), x)
print("WITNESS_RESULT", json.dumps({"n": int(x.size), "mean": float(x.mean())}))
```

Rule: `$mean > 10`.

- Print each measurement as `WITNESS_RESULT` and one JSON object. Convert numpy values with `int()` or `float()`.
- A probe with dependencies must set `exclude-newer` under `[tool.uv]` to a fixed date. Use today's date. Witness refuses a probe without it, or with a relative date such as "1 week".
- The probe runs in an empty folder. The folder holds the probe and the declared inputs only.
- Save files for other questions in `$WITNESS_OUT`.
- If the measurement did not occur, stop the probe with an error. A crash gives `failed`, not `no`.
- Do not act in a probe. Do not send or deploy. Witness runs a question again when its inputs change, so the action occurs again.
- The time limit is 600 seconds (`timeout_s`). `ask` waits 120 seconds (`wait_s`). After that, the run continues.

Start from [assets/probe.py](assets/probe.py).

## Asking well

- Put the conditions in the question: "With 8 workers on data.csv, is …?"
- Declare each file that the probe reads, and no other file.
- A search that finds nothing is not a proof. Ask "Within N cases, does X find Z?"

## Reading the graph

`query` runs read-only Cypher. The query tool description shows the graph. Witness does not store the current answers. It gives them as parameters: `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting` (question ids), `$replaced` (crashed questions that a fix replaces), and `$current` (the runs that give the current answers). For open problems, use `WHERE q.id IN $failed AND NOT q.id IN $replaced`. Each run has `started` (milliseconds since 1970) and `ms` (how long it took).

Relate query basics:

- Use the labels, relationships and properties in the tool description.
- Pass values through `params`: `$id` needs `{"id": "q-…"}`. Missing parameters are errors, not nulls.
- `WITH` carries variables to the next clause. Keep each variable you still need.
- Bound traversals (`*0..5`) and returned rows (`LIMIT 50`).
- Use `$current` for current runs. A stored `r.answer` can describe an old run.
- The graph keeps each question's probe text (`q.probe`). To reuse or check a probe, read it from the graph. A draft in `scratch/` may have changed since the run.
- Do not assume Neo4j procedures or APOC functions are available.

```cypher
MATCH (q:Question {id: $id})-[:NEEDS*0..5]->(u:Question)
RETURN DISTINCT u.id, u.text LIMIT 50

MATCH (r:Run)-[:OF]->(q:Question) WHERE r.id IN $current
RETURN q.id, q.text, r.answer, r.ms ORDER BY r.ms DESC LIMIT 50
```

For more syntax, see [Relate's Cypher guide](https://github.com/relatedb/relate/blob/main/surfaces/relate-cli/src/skill/bundle/SKILL.md#cypher). It tracks upstream; check newer features against Witness's pinned Relate version.

`look` shows a saved file. Images come back as images. Each tool returns structured content: `query` gives `{rows, truncated}`, `look` gives `{name, file, type, bytes, text, truncated}`, and `ask` and `goal` give the status they report.

In the page's Evidence panel, read measured values beside their rule clauses and any extra values in Measurements. Values use larger, semibold mono text; names stay smaller and muted. The page displays the exact recorded JSON values, without rounding, renamed fields or inferred units.

In the page, the `seq` slider selects a recorded step. The goal dropdown, Evidence, question links and WebMCP `query` and `show_question` use that same step. Query first to find questions available there; a future question cannot be opened. Rewinding clears selections and Back entries for questions not yet asked. An unrun question stays `waiting` if a producer has not measured or has not saved the required file. Measured `no` and rule-failed runs can still supply saved files. History shows completed runs, not past running intervals. Move the slider to the end to return to the latest view. The slider does not execute probes or change the record.

## Reporting

Report question ids and answers. For each goal you worked on, give its id, its completion and its acceptance question first. Do not infer completion from the number of exploratory yes answers:

```
q-3f9a1c0b7e2d yes      the total is exact (2,000 cases)
q-81d0aa94c3f1 no       16 workers is not faster (ratio 0.98)
q-c02e5bd1a7a8 failed   the run did not measure p
```
