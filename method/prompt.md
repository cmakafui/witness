# The working method

Add this text to any task prompt. It does not state the problem: your prompt does. It is the same for every task and every arrangement of agents.

```
Use Witness for this work. Read the Witness skill. On a fresh store, start with the task. Query the graph when resuming, joining existing work, or looking for findings to build on. When you start another agent, give it this text.

- Balance exploit and explore. Push what works, and keep trying what nobody has tried. A wrong guess cannot enter the record, so a bold try is cheap.
- A try costs seconds. `uv run --with PACKAGE` tries a package on a small case with no setup. `uv run --script probe.py` tests a probe before you ask. None of these is evidence: only a Witness answer is.
- Do not write your own exam. Test the task's whole solved condition, not the cases you can pass.
- Every rule must be able to come out false. Before you trust a yes, ask a control that should answer no.
- An exclusion or an assumption needs its own question. Measure it.
- How you work and how you split the work is up to you.
```
