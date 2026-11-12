---
name: witness
description: Use Witness, the workspace's graph of tested answers, instead of claims and notes. Ask yes/no questions as small uv Python probes (any PyPI package); Witness runs each probe on only the files it declares, records the answer, the results, the saved files and the packages, and runs the question again when its inputs change. Every agent in the workspace shares the graph. Use when the witness MCP tools (ask, query, look) are available, and especially when investigating a bug or a dataset, attacking a hard problem, working with other agents, before claiming that something works or does not, and before building on another agent's result.
---

# Witness

Witness keeps the tested answers of every agent in this workspace in one graph. A finding counts only when a run answers it. Nobody writes an answer, you included.

| Word | Meaning |
|---|---|
| **Question** | One yes/no question, the rule that decides it, its probe, and its inputs. Asked once, never edited: a changed question is a new question. |
| **Probe** | A Python script that uv runs. It measures, then prints the answer. |
| **Input** | A file the probe reads: a workspace path, or `q-…/name` for a file another question saved. |
| **Run** | One execution of a probe: its answer, its results, the files it saved, the packages it used. |
| **Answer** | `yes` or `no`. `failed` when the run crashed, timed out or did not answer. `pending` when its inputs changed and it runs again. `waiting` when a question it reads has no answer yet. |

## The loop

1. **Look first.** Call `query` to see what others asked and answered: `MATCH (q:Question) RETURN q.id, q.text, q.asker ORDER BY q.seq DESC LIMIT 30`. Use an answer that exists. Build on an output that exists.
2. **Try your tools small.** Run your code on a small case in your shell first. That is not evidence. It only shows that the probe will work.
3. **Ask.** Call `ask` with the question, the rule, the probe and every file it reads. Write the rule before anything runs: "yes when p < 0.01 and the gain is at least 10%". Pass `asker` with your name or role.
4. **Read the answer.** Read the results and the saved files. When data is hard to read raw, have the probe draw it, then `look` at the picture. A picture gives you the next question. It does not answer one.
5. **Ask the next question.** Ask where the claim stops holding. Ask the question that would show it is wrong, and give the claim's id in `disputes`.

## Asking well

- **Put the conditions in the question.** "With 8 workers on data.csv, is …?" A question without conditions reads as true everywhere.
- **Declare every file the probe reads, and only those.** The probe runs in an empty folder that holds only the probe and its inputs. A file you did not declare is not there. A file you declare without need makes the answer go stale for nothing.
- **Earn the "no".** Before you answer, check that the measurement happened: the file was read, the list is not empty. Crash if it did not. A crash is `failed`, never `no`.
- **A search that found nothing proves nothing**, unless it was complete. Ask "Within N cases, does X find Z?"
- **Judge against a reference** when there is one: run the same input through a trusted tool and answer by whether the two agree.
- **Save what others can use** to `$WITNESS_OUT`: tables, candidates, models, plots. Another question reads it as `q-…/name`. When that question's answer changes, every question that reads its output runs again.

## The probe

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.3.4"]
# ///
import json, os
import numpy as np

x = np.loadtxt("data.txt")                     # an input, at the path you declared
assert x.size, "no data: the measurement did not happen"

np.save(os.path.join(os.environ["WITNESS_OUT"], "x.npy"), x)        # a file others can read
print("WITNESS_RESULT", json.dumps({"n": int(x.size), "mean": float(x.mean())}))
print("WITNESS_ANSWER", "yes" if x.mean() > 10 else "no")            # exactly once
```

- `WITNESS_RESULT {json}`: any number of times, one per measurement.
- `WITNESS_ANSWER yes|no`: exactly once, at the end.
- Pin versions in the header. The packages each run used are in the graph.
- A loop or a sweep goes inside the probe. The probe answers once.
- The default time limit is 600 seconds (`timeout_s` changes it). `ask` waits up to 120 seconds (`wait_s`), and the run goes on after that.

Start from [assets/probe.py](assets/probe.py).

## Reading the graph

`query` runs read-only Cypher. Answers are never stored: they come as parameters. `$yes`, `$no`, `$failed`, `$running`, `$pending` and `$waiting` are lists of question ids, and `$current` lists the runs that give the current answers.

```cypher
// What is answered yes, and nothing tried to disprove?
MATCH (q:Question) WHERE q.id IN $yes AND NOT EXISTS { (:Question)-[:DISPUTES]->(q) }
RETURN q.id, q.text

// What does this result rest on?
MATCH (q:Question {id: $id})-[:NEEDS*0..]->(u:Question) RETURN DISTINCT u.id, u.text

// What did the current run of a question save, and with which packages?
MATCH (r:Run)-[:ANSWERS]->(:Question {id: $id}) WHERE r.id IN $current
OPTIONAL MATCH (r)-[s:SAVED]->(f:File) OPTIONAL MATCH (r)-[:USED]->(p:Package)
RETURN collect(DISTINCT s.name) AS saved, collect(DISTINCT p.id) AS packages

// Why did runs fail?
MATCH (a:Answer {value: 'failed'})-[:OF]->(:Run)-[:ANSWERS]->(q:Question) RETURN q.id, a.reason
```

The `query` tool's description has the whole graph.

## Reporting

Report question ids and answers, not a story:

```
q-3f9a1c0b7e2d yes      the total is exact to the cent (2,000 cases)
q-81d0aa94c3f1 no       16 workers is not faster (ratio 0.98, p = 0.41)
q-c02e5bd1a7a8 failed   playwright could not start: see query for its reason
look q-3f9a1c0b7e2d/residuals.png   the error is all in the top-right corner
```

The person running the workspace watches the graph live. `witness status` in the workspace prints the page's address.
