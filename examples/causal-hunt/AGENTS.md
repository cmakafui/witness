# Causal hunt

Six variables, `x1` to `x6`, are measured on one system. Some of them cause others. `observational.csv` holds 2000 rows of the system left alone. `experiment.py` is a rig that sets variables to values you choose and reads all six, but it has a budget of 7 experiments, shared by everyone working in this lab. Something you can't measure also moves some of the variables.

## Goal

1. Say what the passive data can tell you and what it can't, before spending any experiment.
2. Decide which experiments are worth their cost. The budget is smaller than it feels, and an experiment spent twice is spent.
3. Recover the direct causes: which variables directly cause which, as directed edges among `x1` to `x6`. A cause that works through another variable is not a direct edge.
4. Say which pair of variables the unmeasured influence moves.
5. Predict what happens under interventions that were never run, including setting two variables at once.
6. Save your answer as a model: a Python file `model.py` with two functions.
   - `graph()` returns `{"edges": [["x2", "x5"], ...], "confounded": [["x1", "x3"]]}`: each edge is `[cause, effect]`, and `confounded` lists the pair or pairs whose variables share the unmeasured influence.
   - `intervene(do)` takes a dict such as `{"x2": 1.5, "x4": -2.0}` and returns the expected value of every variable, `{"x1": ..., ..., "x6": ...}`, when those variables are set to those values.
   It may import numpy and the standard library, and nothing else. It must not read files.

## Solved means

A saved `model.py` that passes the lab's judge, which you do not have. It requires all of:

- the directed edges are exactly right;
- the confounded pair is exactly right;
- on 30 held-out interventions (values between 1 and 3 in size, one or two variables set), the 90th percentile of the absolute error of the expected values of the variables that were not set is at most 0.3;
- the experiment log shows no more than 7 experiments.

Because you can't run the judge, solved is established the way research is: Witness questions whose probes test the model against what you measured, and say where it stops holding. Ask the no's too: a model that fits the passive data can still be wrong about what setting a variable does.

## Rules

- Work only from the files in this directory. Don't look outside it, and don't search the web for this problem's solution.
- The rig is a black box. Don't read its internals, and never delete, edit or work around `experiments.log`: the judge verifies it. The experiments you ran are the ones you get.
- **Experiments are collected, never asked.** Run the rig from your shell, in this directory, and save its rows straight to a file: `uv run --script experiment.py --do x3=1.5 --rows 500 > data/exp1.csv`. Never run the rig inside a probe: Witness runs a question again when its inputs change, and an experiment run again is spent again. Every analysis of the rows is a Witness question with the CSV file as a declared input.
- Before running an experiment, query the graph and list `data/` for one already run, and run `uv run --script experiment.py --status` for what is left. One agent holds the budget: nobody else spends it. Write down why each experiment is worth its cost before you run it.
- Witness is the record. Read the witness skill (`.agents/skills/witness/SKILL.md`) in full before starting. Nothing you run yourself is evidence: a finding counts once a Witness question answers it. `ask` runs a question and returns its answer. Each agent passes `asker` with its name or role.
- Declare the files each question reads as inputs, and save what others can build on (estimates, residuals, designs, `model.py`) to `$WITNESS_OUT`. When something is hard to read raw, draw it and `look`.
- Put the settings a probe fixes in the question text, so an answer is never read as true under settings it didn't run with.
- Ask where each claim stops holding, and dispute your own claims. A session with only yes answers hasn't tested anything.
- A search that finds nothing is a bounded no ("none in this family, with this method"), never proof that nothing exists.
- Scratch files go in `scratch/`. Anything another agent needs is a saved output, not a scratch file.

## This machine

- Everything here runs in seconds on a few cores. No GPU is needed.
- Probes are Python, run by `uv` (anything on PyPI: numpy, scipy, statsmodels, networkx, causal-learn, sklearn).
- Multi-agent work is authorized: an orchestrator may brief subagents, each with one direction.
