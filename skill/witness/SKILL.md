---
name: witness
description: Use Witness to record findings as tested answers, not notes. Ask a yes/no question with a rule and a probe. The probe is a uv Python script that measures. The rule is a Cypher expression that decides yes or no from the measurements. Witness runs the probe on its declared files only, and runs the question again when a file changes. All agents in the workspace share the answers. Use when the witness MCP tools (ask, query, look) are available, before you claim that something works or does not, and before you build on the result of another agent.
---

# Witness

Witness keeps the tested answers of all agents in this workspace in one graph. No agent writes an answer. The probe measures. The rule decides.

| Term | Meaning |
|---|---|
| **Question** | One yes/no question, with its rule, probe and inputs. You cannot edit a question. A changed question is a new question. |
| **Rule** | A Cypher expression over the measurements. True gives yes. False gives no. |
| **Probe** | A Python script that uv runs. It prints measurements. It does not give an answer. |
| **Input** | A file that the probe reads: a workspace path, or `q-…/name` for a file that another question saved. |
| **Run** | One execution of the probe: the measurements, the answer, the files read and saved, the packages used. |
| **Answer** | `yes`, `no` or `failed`. `pending`: an input changed, and the question runs again. `waiting`: a question that it reads has no answer yet. |

## Steps

1. Call `query` before you ask. Use an answer that exists.
2. Run the probe yourself on a small case. This shows that the probe works. It is not evidence.
3. Call `ask` with the question, the rule, the probe and all inputs. Give `asker` your name or role.
4. Read the answer, the measurements and the saved files.

## The rule

Write the rule before the probe runs.

- `$name` is the last measurement with that name.
- `$results` is the list of all measurements, in order: `all(r IN $results WHERE r.error <= 0.3)`.
- You can use comparisons, `AND`, `OR`, `NOT` and Cypher functions such as `abs()`, `all()`, `any()` and `size()`.
- The answer is `failed` if the rule names a measurement that the run did not print, if a value is null, or if the result is not true or false.
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

## Disputes

To test a claim, ask a question where yes means that the claim is wrong. Put the id of the claim in `disputes`.

- If the dispute gives yes, the claim is refuted. `$refuted` lists the refuted questions.
- If the dispute gives no, the claim passed that test.

## Reading the graph

`query` runs read-only Cypher. The query tool description shows the graph. Witness does not store the current answers. It gives them as parameters: `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting` and `$refuted` (question ids), and `$current` (the runs that give the current answers).

```cypher
MATCH (q:Question {id: $id})-[:NEEDS*0..]->(u:Question) RETURN DISTINCT u.id, u.text
MATCH (r:Run {answer: 'failed'})-[:OF]->(q:Question) RETURN q.id, r.reason
```

`look` shows a saved file. Images come back as images.

## Reporting

Report question ids and answers:

```
q-3f9a1c0b7e2d yes      the total is exact (2,000 cases)
q-81d0aa94c3f1 no       16 workers is not faster (ratio 0.98)
q-c02e5bd1a7a8 failed   the run did not measure p
```
