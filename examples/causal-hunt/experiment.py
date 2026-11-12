# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""The lab's experiment rig: set variables, get rows back. Treat it as a black box: its internals are not part of the problem.

usage: uv run --script experiment.py --do x3=1.5 [--do x5=-1] [--rows 200]   one experiment: set the named variables, read all six
       uv run --script experiment.py --status                                 how many experiments are left
Each call with --do or --rows is one experiment and uses one of the lab's budget, whatever its row count. It prints CSV (x1..x6)
to stdout. Every experiment is logged next to this file; the judge reads the log. Run it on this machine, not in a sandbox.
"""
import argparse, base64, hashlib, json, sys, zlib
from pathlib import Path
import numpy as np

_P = json.loads(zlib.decompress(base64.b64decode("eJyFkMEKwjAMhl+l5NyVdOt09ejZNxhDtrWKiGxsisrYu5t0Q4agXkKafP3zJwO0sBEDNJ3zHWW5lsJIEUuRSJFKgYUUsOVGjgqliFBZKkdaacK0SogMDSqsiZ2oL+HdJ5WV+UnMmvhJLQCr/yssg7UTwBvVvBG5SIOXNTf0ZIvTEAxzvSMwALAL11EYFrZfRkNbnsIZ2X0xsoL3rEGD4OyflIFdZQdXl7Zyqcuy2BtXofemBkKqmzv6K1E88VI+9l1z7/k74lxwDT8Vji8ZLl3b")))
HERE = Path(__file__).resolve().parent
LOG = HERE / "experiments.log"
NAMES = [f"x{i + 1}" for i in range(len(_P["p"]["c"]))]


def link(prev, k, do, rows):
    return hashlib.sha256(f"{prev}|{k}|{json.dumps(do, sort_keys=True)}|{rows}|{_P['key']}".encode()).hexdigest()[:16]


entries = [json.loads(x) for x in LOG.read_text().splitlines()] if LOG.exists() else []
ap = argparse.ArgumentParser()
ap.add_argument("--do", action="append", default=[], metavar="xN=VALUE")
ap.add_argument("--rows", type=int)
ap.add_argument("--status", action="store_true")
a = ap.parse_args()
left = _P["budget"] - len(entries)
if a.status:
    print(f"{len(entries)} of {_P['budget']} experiments used; {left} left", file=sys.stderr)
    sys.exit(0)
rows = a.rows if a.rows is not None else 200
do = {}
for s in a.do:
    name, _, val = s.partition("=")
    if name not in NAMES or not val:
        sys.exit(f"bad --do {s!r}: use xN=VALUE with N in 1..{len(NAMES)}")
    do[name] = float(val)
    if abs(do[name]) > _P["max_do"]:
        sys.exit(f"--do values must be within +-{_P['max_do']}")
if not 1 <= rows <= _P["max_rows"]:
    sys.exit(f"--rows must be 1..{_P['max_rows']}")
if left <= 0:
    print("no experiments left in the budget", file=sys.stderr)
    sys.exit(3)
k = len(entries) + 1
prev = entries[-1]["hash"] if entries else "0"
with LOG.open("a") as f:
    f.write(json.dumps({"n": k, "do": do, "rows": rows, "prev": prev, "hash": link(prev, k, do, rows)}) + "\n")
p = _P["p"]
rng = np.random.default_rng([_P["seed"], k])
B, c, L = np.array(p["B"]), np.array(p["c"]), np.array(p["L"])
idx = {n: i for i, n in enumerate(NAMES)}
h = rng.normal(size=rows)
X = np.zeros((rows, len(NAMES)))
for v in p["order"]:
    X[:, v] = do[NAMES[v]] if NAMES[v] in do else X @ B[v] + c[v] + p["sd"] * rng.normal(size=rows) + L[v] * h
print(",".join(NAMES))
for r in X:
    print(",".join(f"{x:.4f}" for x in r))
print(f"experiment {k} of {_P['budget']}: {left - 1} left", file=sys.stderr)
