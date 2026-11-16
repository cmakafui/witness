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

1. Call `query` before you ask. Use an answer that exists.
2. Run the probe yourself on a small case. This shows that the probe works. It is not evidence.
3. Call `ask` with the question, the rule, the probe and all inputs. Give `asker` your direction of work. The page gives each direction its own row.
4. Read the answer, the measurements and the saved files.

## Goals and acceptance

Call `query` to find the goal before creating one. `goal({text: "…"})` creates a new goal every time, even for identical text. Its id starts with `g-`. An unbound goal is open and incomplete.

- Use `ask` with `accepts: "g-…"` for the goal’s acceptance question. Leave it out for every other question. Those answers never determine completion, whether yes, no or failed.
- Write the acceptance contract before executing it. Witness writes the question and binding atomically before the probe starts. You can bind only one acceptance question per goal. An identical retry is allowed; a different contract requires a new goal.
- Acceptance binding is part of identity. `accepts` creates a distinct question bound before execution; an existing run cannot be promoted in place.
- Only the acceptance question’s **current** yes completes the goal. No, failed, pending, running and waiting all mean incomplete. Input changes invalidate completion; restoring the inputs restores their latest recorded answer. Completion is never stored.
- An `ask` with `accepts` returns the goal’s completion alongside the question’s answer. Query `$complete` and `$incomplete` for goal ids.

An acceptance question can read a candidate file directly or consume `q-…/name`. Its rule tests the solved condition. Exploration can keep producing negative answers while the goal is complete.

```cypher
MATCH (g:Goal)
OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id AS goal, g.text, g.id IN $complete AS complete, q.id AS acceptance
ORDER BY g.seq
```

## Asking again

- A run that measured is final for its inputs. The same `ask` returns it, whether the answer is yes, no or failed. To measure again, change an input or ask a new question.
- A run that crashed or timed out settles nothing. Send the same `ask` arguments to retry it. Keep the text, rule, probe, inputs and `accepts` unchanged. Witness does not retry on its own.
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
- Do not act in a probe. Do not send, deploy, or use a budget. Witness runs a question again when its inputs change, so the action occurs again.
- The time limit is 600 seconds (`timeout_s`). `ask` waits 120 seconds (`wait_s`). After that, the run continues.

Start from [assets/probe.py](assets/probe.py).

## Asking well

- Put the conditions in the question: "With 8 workers on data.csv, is …?"
- Declare each file that the probe reads, and no other file.
- A search that finds nothing is not a proof. Ask "Within N cases, does X find Z?"

## Reading the graph

`query` runs read-only Cypher. The query tool description shows the graph. Witness does not store the current answers. It gives them as parameters: `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting` (question ids), and `$current` (the runs that give the current answers). Each run has `started` (milliseconds since 1970) and `ms` (how long it took).

Relate query basics:

- Use the labels, relationships and properties in the tool description.
- Pass values through `params`: `$id` needs `{"id": "q-…"}`. Missing parameters are errors, not nulls.
- `WITH` carries variables to the next clause. Keep each variable you still need.
- Bound traversals (`*0..5`) and returned rows (`LIMIT 50`).
- Use `$current` for current runs. A stored `r.answer` can describe an old run.
- Do not assume Neo4j procedures or APOC functions are available.

```cypher
MATCH (q:Question {id: $id})-[:NEEDS*0..5]->(u:Question)
RETURN DISTINCT u.id, u.text LIMIT 50

MATCH (r:Run)-[:OF]->(q:Question) WHERE r.id IN $current
RETURN q.id, q.text, r.answer, r.ms ORDER BY r.ms DESC LIMIT 50
```

For more syntax, see [Relate's Cypher guide](https://github.com/relatedb/relate/blob/main/surfaces/relate-cli/src/skill/bundle/SKILL.md#cypher). It tracks upstream; check newer features against Witness's pinned Relate version.

`look` shows a saved file. Images come back as images.

In the page, the `seq` slider selects a recorded step. The goal dropdown, Evidence, question links and WebMCP `query` and `show_question` use that same step. Query first to find questions available there; a future question cannot be opened. Rewinding clears selections and Back entries for questions not yet asked. An unrun question stays `waiting` if a producer has not measured or has not saved the required file. Measured `no` and rule-failed runs can still supply saved files. History shows completed runs, not past running intervals. Move the slider to the end to return to the latest view. The slider does not execute probes or change the record.

## Reporting

Report the goal id, its completion and acceptance question, then question ids and answers. Do not infer completion from the number of exploratory yes answers:

```
q-3f9a1c0b7e2d yes      the total is exact (2,000 cases)
q-81d0aa94c3f1 no       16 workers is not faster (ratio 0.98)
q-c02e5bd1a7a8 failed   the run did not measure p
```
