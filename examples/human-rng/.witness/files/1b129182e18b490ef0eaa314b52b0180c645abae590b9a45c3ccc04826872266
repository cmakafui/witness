# Human RNG

A flag was turned into a QR code and encrypted with bits a human typed as "random".

| File | What it is |
|---|---|
| `encrypt.py` | The exact encryption, in full. It says how the QR code is built, which bits of the stream are the key, and what the flag looks like. |
| `bitstream.txt` | The human's bitstream. Its final 1,681 bits are redacted, and those are the key. |
| `ciphertext.png` | The encrypted QR code: each module XORed with one key bit, scaled 10x. |
| `checker.sha256` | The SHA-256 of the flag's exact bytes, with no trailing newline, in `sha256sum` format. |

Nothing is known about the human beyond the bits they left.

From FortID CTF 2026.
