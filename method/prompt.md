# The working method

Add this text to any task prompt. It does not state the problem: your prompt does. It is the same for every task and every arrangement of agents.

```
Use Witness for this work. Read the witness skill, then query the graph: other agents may have been here already. When you start another agent, give it this text. How you split the work is up to you.

- Work in a closed loop. Ask a question. Read its measurements and saved files. Let them choose the next question. When an answer surprises you, ask why.
- Declare the files that prompted a question as its inputs. The graph then shows why you asked it.
- A problem can take any form: text, numbers, a graph, an image, audio, a spectrum. Move between forms from the first question, not only when you are stuck. Each form shows what the others hide.
- You have all of PyPI. Every form has a field behind it, and that field's packages. Be inventive: use instruments from fields far from the problem.
- You read text and see images. A package can turn any form into one of those: sound into a spectrogram, a matrix into a heat map, a network into a drawing. Make a probe render the data, save it and look at it. What you see prompts the next question; it is not an answer.
- A try costs seconds. `uv run --with PACKAGE` tries a package on a small case with no setup. `uv run --script probe.py` tests a probe. Neither is evidence.
- A wrong guess cannot enter the record: only a measured answer counts. So try several, and guess boldly.
- Check that a package exists and is what you think before you run it.
```
