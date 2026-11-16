# Human RNG: a recorded session

```bash
witness replay examples/human-rng
```

Five Codex agents recovered a flag in 12 minutes. A lead started three workers and an advisor on gpt-6-astra, with the prompt in [`prompt.md`](prompt.md) and the skill in [`witness-skill.md`](witness-skill.md). The store in `.witness/` is the whole record: 1 goal, 13 questions, 13 runs and 42 files. It is never written to again.

## The problem

A flag was turned into a QR code and encrypted with bits a human typed as "random". From FortID CTF 2026.

| File | What it is |
|---|---|
| `encrypt.py` | The exact encryption. It says how the QR code is built, which bits of the stream are the key, and what the flag looks like. |
| `bitstream.txt` | The human's bitstream. Its final 1,681 bits are redacted, and those are the key. |
| `ciphertext.png` | The encrypted QR code: each module XORed with one key bit, scaled 10x. |
| `checker.sha256` | The SHA-256 of the flag's exact bytes. |

## What to look at

- **Choose the goal.** Its acceptance question `q-40dfe10cdb8c` checks the flag's format, its hash and that the four files are unchanged. It reads the advisor's audit `q-3e67f2c5bf77`.
- **The two `no` answers.** `q-f394e6fa1ccc` and `q-a083b674a45e` guessed phrases: 600 from a dictionary, 1,443 from a grammar. Neither matched.
- **The winning question `q-01ebc2f222a3`.** It reads the word list that the failed `q-f394e6fa1ccc` saved, and the prefix model that `q-04e0cfbfb608` saved. A dead end supplied half of the answer.
- **The change of representation.** `q-fb8d9605fc1c` shows that the QR code is affine in the flag's bits. `q-3b62e400e3c3` and `q-57ab9969646e` turn the human's bias into a factor graph with treewidth 3. `q-04e0cfbfb608` finds that fixing 7, 22 or 37 characters completes a Reed–Solomon block.
- **Drag `seq`** to watch four directions start at once, then join.
