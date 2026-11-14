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
3. Call `ask` with the question, the rule, the probe and all inputs. Give `asker` your name or role.
4. Read the answer, the measurements and the saved files.

## Goals and acceptance

Call `query` to find the goal before creating one. `goal({text: "…"})` creates a new goal every time, even for identical text. Its id starts with `g-`. An unbound goal is open and incomplete.

- Use `ask` with `goal: "g-…"` for exploratory questions. Their answers never determine completion, whether yes, no or failed.
- Use `ask` with `accepts: "g-…"` for the goal’s acceptance question. Use either `goal` or `accepts`, never both. Leave both out for questions without a goal.
- Write the acceptance contract before executing it. Witness writes the question and binding atomically before the probe starts. You can bind only one acceptance question per goal. An identical retry is allowed; a different contract requires a new goal.
- Exploratory goal membership is not part of question identity. Repeat the same question with another `goal` to add a `FOR` association and reuse its runs, including a run already in progress. Omitting `goal` also reuses that question. The original question and first asker stay unchanged.
- Acceptance binding is part of identity. `accepts` creates a distinct question bound before execution; an existing exploratory run cannot be promoted in place.
- Only the acceptance question’s **current** yes completes the goal. No, failed, pending, running and waiting all mean incomplete. Input changes invalidate completion; restoring the inputs restores their latest recorded answer. Completion is never stored.
- `ask` returns the associated goal’s completion alongside the question’s answer. Query `$complete` and `$incomplete` for goal ids. They never include exploratory question ids.

An acceptance question can read a candidate file directly or consume `q-…/name`. Its rule tests the solved condition. Exploration can keep producing negative answers while the goal is complete.

```cypher
MATCH (g:Goal)
OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id AS goal, g.text, g.id IN $complete AS complete, q.id AS acceptance
ORDER BY g.seq
```

## Rerunning

- Send the same `ask` arguments with `rerun: true` to measure again, including after a cached failure. Keep the text, rule, probe, inputs and `accepts` binding unchanged. Rerun is not part of question identity and does not edit its record or rule.
- A new Run is appended. Its result becomes the cached answer for those inputs, even if it fails. Older runs and their files remain available through `query` and `look` with `r-…/name`.
- Ordinary asks reuse the latest finished run on the current input key. Restoring previous input bytes restores the latest run on that key, including any explicit rerun.
- Calls for a question already queued or running join that execution; they do not create extra trials. Wait for completion before requesting another trial. On a new question, `rerun: true` runs it once.
- Reruns use the normal worker limit and wait for upstream files. `wait_s: 0` returns immediately while the work continues. Query the question's status afterward.
- During a rerun, the question is pending, running or waiting; its old measurements are not current. Acceptance completion waits for the new answer. A shared exploratory question is rerun for all its goal associations. Consumers rerun automatically only when the saved bytes they read change.
- Rerun allows remeasurement. It does not capture the full environment or establish independence between trials.

## The rule

Write the rule before the probe runs.

- `$name` is the last measurement with that name.
- `$results` is the list of all measurements, in order: `all(r IN $results WHERE r.error <= 0.3)`.
- You can use comparisons, `AND`, `OR`, `NOT` and Cypher functions such as `abs()`, `all()`, `any()` and `size()`.
- The answer is `failed` if the rule names a measurement that the run did not print, if a value is null, or if the result is not true or false.
- A row without a field gives null, and null is not no. Say in the rule what a missing field means: `any(r IN $rows WHERE coalesce(r.error, 1.0) < 0.3)`.
- If the probe measured but the rule could not decide, other questions can still read the files that the run saved. Files of a crash or a timeout cannot be read.
- A rule is one expression. Witness refuses clauses such as `MATCH` and `RETURN`.

## The probe

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.3.4"]
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

In the live page and replay, the goal line opens the chosen goal's acceptance question (`◎`), and the Goals menu lists every goal. The trail lists every question with its text, newest first. Every selected question highlights its own upstream artifact dependencies. All questions clears the selection. Follow Depends on and Used by, or select any trail row; Back restores the previous reading position. Changes lists runs that changed an answer, an input or a rule measurement. The search bar finds questions by words and runs Cypher on Enter. The panel stays open beside the trail and shows the actual rule, clause values, images, and any extra measurements from the current committed run. Values retain their full recorded precision, and All measurements shows every record when there are several. File links marked input open the archived bytes read by that run; saved links open its outputs. Pending work does not display old measurements as current. Use Cypher with `ORDER BY q.seq` or `ORDER BY r.seq` to inspect recorded order. Goal completion remains available through queries and tool replies. Browser agents use `query` and `show_question`; `show_question` selects and highlights the same way as a person clicking a question.

## Reporting

Report the goal id, its completion and acceptance question, then question ids and answers. Do not infer completion from the number of exploratory yes answers:

```
q-3f9a1c0b7e2d yes      the total is exact (2,000 cases)
q-81d0aa94c3f1 no       16 workers is not faster (ratio 0.98)
q-c02e5bd1a7a8 failed   the run did not measure p
```
