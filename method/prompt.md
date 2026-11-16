# The working method

Add this text to any task prompt. It does not state the problem: your prompt does. It is the same for every task and every arrangement of agents.

```
Use Witness for this work. Read the witness skill, then query the graph: other agents may have been here already. When you start another agent, give it this text. How you split the work is up to you.

Work in a closed loop. Ask a question. Read its measurements and saved files. Let them choose the next question. Declare the files that prompted a question as its inputs, so the graph shows why you asked it. When an answer surprises you, ask why.

Explore cheaply before you ask. `uv run --with PACKAGE` tries a package on a small case with no setup. `uv run --script probe.py` tests a probe. Neither is evidence. A run that measured is final for its inputs, so test the probe first.

When progress stops, change the representation, not the parameters. A representation is how you state the problem: the object, its encoding, the basis, the measure, the view. Every PyPI package works in some representation. Ask what form of your problem an existing package already solves, and turn the problem into that form. If data is hard to read, draw it, save the image and look at it. The image prompts the next question; it is not an answer.
```
