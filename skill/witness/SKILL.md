---
name: witness
description: Use Witness to record findings as tested answers, not notes. Ask a yes/no question with a rule and a probe. The probe is a uv Python script that measures. The rule is a Cypher expression that decides yes or no from the measurements. Witness runs the probe on its declared files only, and runs the question again when a file changes. All agents in the workspace share the answers. Work in a closed loop: measure, render, look, and let each answer choose the next question. Use when the witness MCP tools (goal, ask, query, look) are available, before you say that something works or does not work, and before you use the result of another agent.
---

# Witness

No agent writes an answer. A probe measures, and a Cypher rule decides.

## The loop

Work in a loop: measure, change the form, render, look, ask the next question.

A problem can have many forms: text, numbers, a matrix, a graph, an image, a sound, a spectrum. Each form shows what the other forms hide. PyPI has the packages of every field that works with a form, so a probe can move the evidence into any form.

You read text and you see images. A probe can draw the object that it measures (the matrix, the graph, the signal, the layout) as a PNG in `$WITNESS_OUT`. Call `look` on `q-…/name.png` to see the picture. A picture often shows structure that a column of numbers hides: a block, a symmetry, a stripe, an outlier.

A render stays in the graph with its question. Every agent, and the person who watches the page, can see what you saw and why you asked the next question.

A picture gives you a question. It is not an answer. The next probe measures what the picture showed. Declare the files that it uses (`q-…/name`) as inputs. The graph then shows the chain from what you saw to what you asked.

## Steps

1. In a new workspace, start with the task. To continue earlier work, or to join work in progress, query the graph first. Before you start a new direction, search the graph for its words. Another agent may have measured it, ruled it out, or written a probe that you can use again.
2. Write a new probe as a draft in `scratch/<lane>/`, and test it with `uv run --script scratch/<lane>/probe.py`. Each lane has its own folder, so drafts do not overwrite each other. To try a package, use `uv run --with PACKAGE python -c '…'`. A draft is not evidence. Keep drafts out of `.witness/`.
3. Call `ask` with `text`, `rule`, `inputs` and `lane`. Give `probe` for a new script, or `probe_ref: "q-…"` to use the probe of a question that exists.
   - Save outputs and renders in `$WITNESS_OUT`. Other questions read them as `q-…/name`. Do not overwrite a shared workspace file, and do not give a `scratch/` path as an input. An acceptance question refuses `scratch/` inputs.
   - To use the answer and the measurements of another question, give its bare `q-…` as an input. The probe reads them as `q-….json`. Use this for controls and exclusions.
4. Read the answer, the measurements and the saved files. Call `look` on the renders. Give other agents question ids and `q-…/name` paths, not summaries.

Work that stays in `scratch/` is a draft. Other agents cannot use it, and you lose it when you restart. Ask a question about the best result of a search, so that the result goes into the graph.

## Lanes

A lane is one direction of work. Give it a short name of 1 or 2 words, for example `switches` or `qr`. Use the same lane for all questions in that direction. Do not use a question title as a lane. The page shows one row for each lane.

## Working with others

Work counts only when it is in the graph. A claim with a question id can be queried, run again and used. A claim without one is only a story.

- **Subagents.** Give each subagent its own lane. It uses `ask`, `look` and `query` as you do. A question id and a `q-…/name` path give another agent all that it needs. Start subagents with the native subagent tool of the host. Then the subagent is in the same session, and the caller selects its model. A process that you start from a shell is not in the session. The hub runs a fixed number of probes at the same time (the MCP instructions give the number). More probes wait in line.
- **Joining live work.** Separate sessions and model families can share one folder and one hub. No coordinator is necessary. Before you ask, query `$running` (the questions that measure now) and the latest questions of each lane (`ORDER BY q.seq DESC`). Then select a direction that no lane holds. When you use the answer or a file of another session, declare its `q-…` id as an input. That edge is how sessions share work.

## Asking well

- Every rule must be able to give no. Measure the quantity, and let the rule judge it. Before you trust a yes, ask a control that must give no.
- A score gives a search a direction. A yes or a no tells where you are. A number tells which way is better. A probe that saves its candidate and measures its score lets the next question start from the best candidate.
- Test the full solved condition, not only the cases that you can pass.
- An assumption or an exclusion needs its own question. A no rules out only what it tested. A yes is true only under the conditions that it measured.
- A wrong guess cannot go into the record, so a bold try costs little.

## Goals and acceptance

Goals are optional. Call `goal({text})` to make one (`g-…`). Bind one acceptance question to it with `accepts: "g-…"` before that question runs. Only the yes of that question, now, makes the goal complete. A goal does not change. If its acceptance question did not measure (crashed or timed out), make a new goal, and ask the fix with `accepts` and `replaces`.

```cypher
MATCH (g:Goal)
OPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)
RETURN g.id AS goal, g.text, g.id IN $complete AS complete, q.id AS acceptance
ORDER BY g.seq
```

## Probes and rules

Start from [assets/probe.py](assets/probe.py).

- **Probe.** A PEP 723 `uv` script. It runs in an empty temporary folder that holds only its declared `inputs`. It prints `WITNESS_RESULT` and one JSON object for each measurement. Change numpy values to Python values with `int()` or `float()`. It saves outputs for other questions in `$WITNESS_OUT`. A probe only measures. It must not send or deploy.
- **Dependencies.** A probe that installs packages sets `[tool.uv] exclude-newer = "YYYY-MM-DDTHH:MM:SSZ"` to a fixed date. Do not use a relative date.
- **Failures.** If the measurement did not occur, stop the probe with an error. A crash gives `failed`, not `no`, and other questions cannot read its files. To fix the probe of a question that did not measure, ask the fix with `replaces: "q-…"`.
- **Noise.** To measure a noisy quantity, loop in one probe, and let the rule judge `$results`.
- **Rule.** One Cypher expression over `$name` (the last value) and `$results` (all measurement objects). Examples: `$mean > 10`, `all(r IN $results WHERE r.error <= 0.3)`. Use `=` for equality, not `==`. A missing field gives `null`, and `null` gives `failed`, not `no`. Use `coalesce(...)` to say what a missing value means.

## Querying and reporting

To continue work on a large graph, start with a summary. Query the goals, the number of questions in each lane, `$running`, the saved files that no question reads, and the latest 15 questions (`ORDER BY q.seq DESC LIMIT 15`). Return only `id`, `lane`, the answer and `text`. To scan many runs, read `r.last` (the last measurement object), not `r.results`. Read `r.results`, `SAVED` files or `q.probe` only for the questions that you need.

```cypher
MATCH (q:Question)
RETURN q.lane AS lane, count(q) AS total,
       sum(CASE WHEN q.id IN $yes THEN 1 ELSE 0 END) AS yes,
       sum(CASE WHEN q.id IN $no THEN 1 ELSE 0 END) AS no,
       sum(CASE WHEN q.id IN $running THEN 1 ELSE 0 END) AS running
ORDER BY total DESC
```

The saved files of current runs that no question reads yet:

```cypher
MATCH (q:Question)<-[:OF]-(r:Run)-[s:SAVED]->(:File)
WHERE r.id IN $current
  AND NOT EXISTS { MATCH (:Question)-[:NEEDS {name: q.id + '/' + s.name}]->(q) }
RETURN q.id, q.lane, q.id + '/' + s.name AS file, r.answer
ORDER BY q.seq DESC LIMIT 25
```

Search by words before you ask. Give the words as a parameter:

```cypher
MATCH (q:Question)
SEARCH q IN (FULLTEXT INDEX question_text FOR $words LIMIT 10) SCORE AS score
RETURN q.id, q.lane, q.text, q.id IN $yes AS yes, q.id IN $no AS no, score
ORDER BY score DESC
```

- A `no` result is a direction that is ruled out. Read its rule to see what it ruled out.
- A match in the probe text (a package, a function) gives a script that you can use again with `probe_ref`.
- Search `run_reason` for an error before you debug it.
- Words find only words. A search for `bias` does not find a question about `alternation`. Also search for other words with the same meaning.

Relate Cypher:

- Give each `$name` in `params`. A missing parameter is an error.
- `WITH` keeps only the variables that it names. Name each variable that you use later: `WITH q, r, count(f) AS files`.
- Put a limit on traversals (`*0..5`) and on results (`LIMIT 50`).
- There are no Neo4j or APOC procedures.
- `created` and `started` are integer milliseconds. Compare them as integers. Do not use `datetime()`.
- `$current` gives the runs that give the current answers. For open failures, use `WHERE q.id IN $failed AND NOT q.id IN $replaced`.
- Read `q.probe` from the graph, not from `scratch/`.
- The schema writes `{name}` for a property of a relationship. In a query, give it a value (`-[:NEEDS {name: 'q-…/file'}]->`) or leave it out.
- There is one `NEEDS` for each file. A question that reads two files of one question has two edges to it. Use `DISTINCT` when you follow `NEEDS`.

```cypher
MATCH (q:Question)-[:NEEDS*0..5]->(u:Question)<-[:OF]-(r:Run)
WHERE r.id IN $current
RETURN DISTINCT q.id, u.id, r.answer, r.results LIMIT 50
```

Report question ids, answers and goal completion first:

```
q-3f9a1c0b7e2d yes      the total is exact (2,000 cases)
q-81d0aa94c3f1 no       16 workers is not faster (ratio 0.98)
q-c02e5bd1a7a8 failed   the run did not measure p
```
