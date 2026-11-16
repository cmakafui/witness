# Human RNG: the solve prompt

Start Codex in this folder (`labs/crypto/human-rng`), then paste the text below.

```
A flag was turned into a QR code and encrypted with bits a human typed as "random". Recover the flag. README.md describes the files.

Solved means: a Witness question reads a saved candidate flag, encrypt.py and checker.sha256, and measures whether the candidate passes every format check in encrypt.py and whether the SHA-256 of its exact bytes equals the hash in checker.sha256. Its probe also checks that checker.sha256 still holds 1b3b44d30d77a13c586d4f27b44ff2534caccd783ad45c31431cadca78ee4bc4. Its answer is yes.

Work only from this folder. Do not read outside it, and do not search the web for this challenge or its flag. Knowing how QR codes and biased randomness work is fine. Keep encrypt.py, bitstream.txt, ciphertext.png and checker.sha256 unchanged.

Use Witness for this work. Read witness-skill.md in this folder, then query the graph: other agents may have been here already. When you start another agent, give it this text. How you split the work is up to you.

- Work in a closed loop. Ask a question. Read its measurements and saved files. Let them choose the next question. When an answer surprises you, ask why.
- Declare the files that prompted a question as its inputs. The graph then shows why you asked it.
- A problem can take any form: text, numbers, a graph, an image, audio, a spectrum. Move between forms from the first question, not only when you are stuck. Each form shows what the others hide.
- You have all of PyPI. Every form has a field behind it, and that field's packages. Be inventive: use instruments from fields far from the problem.
- You read text and see images. A package can turn any form into one of those: sound into a spectrogram, a matrix into a heat map, a network into a drawing. Make a probe render the data, save it and look at it. What you see prompts the next question; it is not an answer.
- A try costs seconds. `uv run --with PACKAGE` tries a package on a small case with no setup. `uv run --script probe.py` tests a probe. Neither is evidence.
- A wrong guess cannot enter the record: only a measured answer counts. So try several, and guess boldly.
- Check that a package exists and is what you think before you run it.

Start four subagents. One is an advisor on model gpt-6-astra: set the model field of spawn_agent to gpt-6-astra. The other three work on the problem; choose their directions, and give each a different one.

The advisor does not solve. It reads the graph and the saved files, asks what each answer rests on, names forms and packages that nobody has tried, and says when a claim has not been tested. Consult it when an answer surprises you, when progress stops, and before you call the work done. When it asks a question, its asker is advisor.

When you finish, report the flag, the accepting question id, and the question ids that the result rests on.
```
