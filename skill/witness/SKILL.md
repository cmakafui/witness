---
name: witness
description: Use Witness, the workspace's graph of tested answers, instead of claims and notes. Ask yes/no questions as small uv Python probes (any PyPI package) with a rule written before anything runs; Witness runs each probe on only the files it declares, the rule decides the answer from what the probe measured, and the question runs again when its inputs change. Every agent in the workspace shares the graph. Use when the witness MCP tools (ask, query, look) are available, and especially when investigating a bug or a dataset, attacking a hard problem, working with other agents, before claiming that something works or does not, and before building on another agent's result.
---

# Witness

Witness keeps the tested answers of every agent in this workspace in one graph. A finding counts only when a run answers it. Nobody writes an answer, you included: your probe measures, and the rule you wrote before the run decides.

| Word | Meaning |
|---|---|
| **Question** | One yes/no question, its rule, its probe, and its inputs. Asked once, never edited: a changed question is a new question. |
| **Rule** | When the answer is yes, as a Cypher expression over the measurements: `$p < 0.01 AND $gain >= 0.1`. |
| **Probe** | A Python script that uv runs. It measures and prints each measurement. It does not answer. |
| **Input** | A file the probe reads: a workspace path, or `q-…/name` for a file another question saved. |
| **Run** | One execution of a probe: its measurements, the answer the rule gave on them, the files it read and saved, the packages it used. |
| **Answer** | `yes` or `no`. `failed` when the run crashed, timed out, measured nothing, or did not measure what the rule needs. `pending` when its inputs changed and it runs again. `waiting` when a question it reads has no answer yet. |

## The loop

1. **Look first.** Call `query` to see what others asked and answered: `MATCH (q:Question) RETURN q.id, q.text, q.rule, q.asker ORDER BY q.seq DESC LIMIT 30`. Use an answer that exists. Build on an output that exists.
2. **Try it cheaply.** Every PyPI package is in reach. Cheapest first: `uv run --with <package> python -c "…"` to see whether a tool helps on the smallest case that could show it; then `WITNESS_OUT=$(mktemp -d) uv run --script probe.py` on the whole probe. That is not evidence. It only shows the probe will work.
3. **Ask.** Call `ask` with the question, the rule and every file the probe reads. Write what you expect into the rule before anything runs, so a surprise means something. Pass `asker` with your name or role.
4. **Read the answer.** Read the measurements and the saved files. Let the measurement choose the next step.
5. **Ask the next question.** Ask where the claim stops holding, and the question that would break it.

Work in this loop the whole time: pull a tool in, measure it on a small case, keep what the measurement supports. Before you build something by hand, ask what already exists that the problem can be turned into.

## Change the representation, then look

When data is hard to read raw, have a probe redraw it: a graph, a heatmap, a residual plot, a spectrum, a trace, a different basis. Save the picture to `$WITNESS_OUT` and `look` at it. What you see is a hunch, not an answer: turn it into the next question, and declare the picture as that question's input (`q-…/residuals.png`), so the graph shows what prompted it. Do this when you are stuck, and also when you are not: a new view is where new questions come from. When stuck, name the assumption that failed, and change the representation, not the parameters.

## The rule

Write the rule before anything runs. It is the claim, made exact. The probe cannot bend it after the fact, because the probe only reports numbers.

- Each measurement the probe printed is a parameter: `$total`, `$p`, `$gain`. When two measurements share a name, the last one wins.
- `$results` is the list of every measurement, in order. Use it for sweeps: `all(r IN $results WHERE r.error <= 0.3)`, `size([r IN $results WHERE r.p < 0.05]) >= 3`.
- Use any Cypher expression: comparisons, `AND`, `OR`, `NOT`, `abs()`, `all()`, `any()`, `none()`, `size()`, list comprehensions.
- True is `yes`. False is `no`. Anything else is `failed`: a measurement the rule names was never printed, or is null, or the value is not true or false. So a probe that did not measure cannot give a `no`.
- A rule only computes. `MATCH`, `RETURN`, `WITH` and other clauses are refused.

## Asking well

- **Put the conditions in the question.** "With 8 workers on data.csv, is …?" A question without conditions reads as true everywhere.
- **Declare every file the probe reads, and only those.** The probe runs in an empty folder that holds only the probe and its inputs. A file you did not declare is not there. A file you declare without need makes the answer go stale for nothing.
- **Earn the "no".** Measure only what happened. If the file was empty or the list is empty, crash or leave the measurement out: the run is `failed`, never `no`.
- **A search that found nothing proves nothing**, unless it was complete. Ask "Within N cases, does X find Z?"
- **Know what you stand on.** Test the data, the instruments and your own assumptions before you build on them.
- **Judge against a reference** when there is one: run the same input through a trusted tool, measure the difference, and let the rule bound it.
- **Certify a result independently** of whatever produced it, and show that a wrong answer is rejected: alter the input, and measure that the check says no. An error or a timeout is not a rejection.
- **A probe measures. It never acts.** Witness runs a question again whenever its inputs change, so a probe that sends a message, writes outside `$WITNESS_OUT`, deploys, or spends a budget does it again on every rerun. Do the action yourself, save what it returned to a file, and ask about that file.
- **Save what others can use** to `$WITNESS_OUT`: tables, candidates, models, plots. Another question reads it as `q-…/name`. When that question's answer changes, every question that reads its output runs again.

## Disputes

To test a claim, ask a question whose **yes means the claim is wrong**, and give the claim's id in `disputes`. Phrase it that way round: "Does any of the 500 bootstrap replicates break the ordering?", not "Does the ordering hold?".

- A disputed question whose dispute answers `yes` is refuted. `$refuted` in `query` lists them.
- A dispute that answers `no` is a test the claim survived. The best claims have survived several.

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

np.save(os.path.join(os.environ["WITNESS_OUT"], "x.npy"), x)          # a file others can read
print("WITNESS_RESULT", json.dumps({"n": int(x.size), "mean": float(x.mean())}))
```

Asked with the rule `$mean > 10`.

- `WITNESS_RESULT {json object}`: any number of times, one per measurement. Name what you measured. Convert numpy values with `float()` or `int()`: `json` cannot write them.
- Pin versions in the header. The packages each run used are in the graph.
- A loop or a sweep goes inside the probe. Print one result per case, and let the rule read `$results`.
- The default time limit is 600 seconds (`timeout_s` changes it). `ask` waits up to 120 seconds (`wait_s`), and the run goes on after that.

Start from [assets/probe.py](assets/probe.py).

## Reading the graph

`query` runs read-only Cypher. Answers now are never stored: they come as parameters. `$yes`, `$no`, `$failed`, `$running`, `$pending`, `$waiting` and `$refuted` are lists of question ids, and `$current` lists the runs that give the current answers.

```cypher
// Which yes answers survived every dispute, and how many?
MATCH (q:Question) WHERE q.id IN $yes AND NOT q.id IN $refuted
OPTIONAL MATCH (d:Question)-[:DISPUTES]->(q)
RETURN q.id, q.text, count(d) AS disputes ORDER BY disputes DESC

// What does this result rest on?
MATCH (q:Question {id: $id})-[:NEEDS*0..]->(u:Question) RETURN DISTINCT u.id, u.text

// The current run of a question: what it measured, saved and used
MATCH (r:Run)-[:OF]->(:Question {id: $id}) WHERE r.id IN $current
OPTIONAL MATCH (r)-[s:SAVED]->(:File)
RETURN r.results, r.packages, collect(s.name) AS saved

// Why did runs fail?
MATCH (r:Run {answer: 'failed'})-[:OF]->(q:Question) RETURN q.id, r.reason
```

The `query` tool's description has the whole graph.

## Reporting

Report question ids and answers, not a story:

```
q-3f9a1c0b7e2d yes      the total is exact to the cent (2,000 cases)       $error = 0
q-81d0aa94c3f1 no       16 workers is not faster (ratio 0.98, p = 0.41)   $ratio > 1.1 AND $p < 0.01
q-c02e5bd1a7a8 failed   the run did not measure p: see query for its reason
look q-3f9a1c0b7e2d/residuals.png   the error is all in the top-right corner
```

The person running the workspace watches the graph live with `witness open`.
