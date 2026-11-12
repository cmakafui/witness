"""The hidden causal system, its experiment rig and its judge, shared by generate.py, solve.py and check.py. Never shown to agents.

The system: six variables x1..x6 from a linear-Gaussian structural model on a random DAG (the column order is NOT the causal
order), with intercepts, plus one hidden confounder h that adds to exactly two of the variables. The confounded pair is
sometimes also joined by a direct edge. Agents get 2000 passive rows and a rig that sets variables (`do`) and returns rows,
with a budget of experiments. Traps: the confounded pair is correlated without cause (or, when adjacent, its regression
slope is biased); colliders and chains look alike in passive data; the budget is smaller than it feels.

The judge asks for the directed edges among x1..x6, the confounded pair, and the mean of every variable under 30 held-out
interventions (15 single, 15 double), which can't be answered without direct effects, not only total effects.
"""
import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

import numpy as np

N = 6
NAMES = [f"x{i + 1}" for i in range(N)]
SD = 0.7
OBS_ROWS = 2000
BUDGET = 7
MAX_ROWS = 500
MAX_DO = 5.0
CAP_PRED = 0.3  # p90 of the absolute error of the interventional means
LOG = "experiments.log"


def draw_params(seed: int) -> dict:
    rng = np.random.default_rng(seed)
    while True:
        order = [int(i) for i in rng.permutation(N)]
        B = np.zeros((N, N))
        edges = []
        for a in range(N):
            for b in range(a + 1, N):
                if rng.random() < 0.45:
                    B[order[b], order[a]] = round(float(rng.uniform(0.6, 1.4)) * float(rng.choice([-1, 1])), 2)
                    edges.append((order[a], order[b]))
        if 5 <= len(edges) <= 9:
            break
    adjacent = {tuple(sorted(e)) for e in edges}
    pairs = [(i, j) for i in range(N) for j in range(i + 1, N)]
    pool = sorted(adjacent) if rng.random() < 0.5 else [p for p in pairs if p not in adjacent]
    pair = pool[int(rng.integers(len(pool)))]
    L = [0.0] * N
    for v in pair:
        L[v] = round(float(rng.uniform(0.8, 1.3)) * float(rng.choice([-1, 1])), 2)
    c = [round(float(x), 1) for x in rng.normal(0, 0.5, N)]
    return {"order": order, "B": B.tolist(), "c": c, "sd": SD, "L": L, "pair": [int(pair[0]), int(pair[1])]}


def sample(p: dict, rng, n: int, do: dict | None = None):
    """Rows from the system; `do` maps a variable index to the value it is set to."""
    B, c, L, do = np.array(p["B"]), np.array(p["c"]), np.array(p["L"]), do or {}
    h = rng.normal(size=n)
    X = np.zeros((n, N))
    for v in p["order"]:
        X[:, v] = do[v] if v in do else X @ B[v] + c[v] + p["sd"] * rng.normal(size=n) + L[v] * h
    return X


def true_means(p: dict, do: dict) -> np.ndarray:
    B, c = np.array(p["B"]), np.array(p["c"])
    m = np.zeros(N)
    for v in p["order"]:
        m[v] = do[v] if v in do else B[v] @ m + c[v]
    return m


def edges_of(p: dict) -> list[tuple[str, str]]:
    B = p["B"]
    return [(NAMES[u], NAMES[v]) for v in range(N) for u in range(N) if B[v][u] != 0]


def make_heldout(p: dict, seed: int) -> dict:
    rng = np.random.default_rng(seed + 1000)
    specs = []
    for k in (1, 2):
        for _ in range(15):
            vs = rng.choice(N, size=k, replace=False)
            specs.append({int(v): round(float(rng.uniform(1, 3)) * float(rng.choice([-1, 1])), 2) for v in vs})
    return {"do": [{NAMES[v]: x for v, x in s.items()} for s in specs], "mean": [true_means(p, s).tolist() for s in specs]}


# ---- the experiment rig: written into the lab as experiment.py ----

INSTRUMENT = '''# /// script
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

_P = json.loads(zlib.decompress(base64.b64decode("__BLOB__")))
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
    f.write(json.dumps({"n": k, "do": do, "rows": rows, "prev": prev, "hash": link(prev, k, do, rows)}) + "\\n")
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
'''


def instrument_source(p: dict, seed: int, key: str) -> str:
    blob = base64.b64encode(zlib.compress(json.dumps({"p": p, "seed": seed, "key": key, "budget": BUDGET, "max_rows": MAX_ROWS, "max_do": MAX_DO}).encode())).decode()
    return INSTRUMENT.replace("__BLOB__", blob)


def link(prev: str, k: int, do: dict, rows: int, key: str) -> str:
    return hashlib.sha256(f"{prev}|{k}|{json.dumps(do, sort_keys=True)}|{rows}|{key}".encode()).hexdigest()[:16]


def write_log(path: Path, entries: list[tuple[dict, int]], key: str):
    prev, out = "0", []
    for k, (do, rows) in enumerate(entries, 1):
        h = link(prev, k, do, rows, key)
        out.append(json.dumps({"n": k, "do": do, "rows": rows, "prev": prev, "hash": h}))
        prev = h
    path.write_text("\n".join(out) + ("\n" if out else ""))


def verify_log(lab: Path, key: str, budget: int) -> tuple[bool, int, str]:
    f = Path(lab) / LOG
    if not f.exists():
        return True, 0, "no experiments in the log"
    prev, k = "0", 0
    try:
        for line in f.read_text().splitlines():
            e = json.loads(line)
            k += 1
            if e["n"] != k or e["prev"] != prev or e["hash"] != link(prev, k, e["do"], e["rows"], key):
                return False, k, "the experiment log does not verify"
            prev = e["hash"]
    except Exception:
        return False, k, "the experiment log does not verify"
    return k <= budget, k, f"{k} of {budget} experiments used"


# ---- models and the judge ----

def model_source(edges, conf, B=None, c=None, mu=None, sigma=None, mode="scm") -> str:
    head = f"import numpy as np\nNAMES = {NAMES!r}\nEDGES = {[list(e) for e in edges]!r}\nCONF = {[list(e) for e in conf]!r}\n\n\ndef graph():\n    return {{'edges': EDGES, 'confounded': CONF}}\n\n\n"
    if mode == "scm":
        body = f"B = np.array({B!r})\nc = np.array({c!r})\n\n\ndef intervene(do):\n    D = [NAMES.index(k) for k in do]\n    F = [i for i in range(len(NAMES)) if i not in D]\n    v = np.array([do[NAMES[i]] for i in D])\n    m = np.zeros(len(NAMES))\n    m[D] = v\n    m[F] = np.linalg.solve(np.eye(len(F)) - B[np.ix_(F, F)], c[F] + B[np.ix_(F, D)] @ v)\n    return {{n: float(m[i]) for i, n in enumerate(NAMES)}}\n"
    elif mode == "conditional":  # what passive data says: the mean given the values, not the mean when they are set
        body = f"MU = np.array({mu!r})\nS = np.array({sigma!r})\n\n\ndef intervene(do):\n    D = [NAMES.index(k) for k in do]\n    F = [i for i in range(len(NAMES)) if i not in D]\n    v = np.array([do[NAMES[i]] for i in D])\n    m = MU.copy()\n    m[D] = v\n    m[F] = MU[F] + S[np.ix_(F, D)] @ np.linalg.solve(S[np.ix_(D, D)], v - MU[D])\n    return {{n: float(m[i]) for i, n in enumerate(NAMES)}}\n"
    else:  # "baseline": nothing changes
        body = f"MU = np.array({mu!r})\n\n\ndef intervene(do):\n    return {{n: float(do.get(n, MU[i])) for i, n in enumerate(NAMES)}}\n"
    return head + body


class CannotJudge(Exception):
    """No verdict: the model crashed, timed out or returned the wrong shape. Exit 2, never a rejection."""


RUNNER = """
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("submitted_model", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
specs = json.load(open(sys.argv[2]))
g = m.graph()
pred = [m.intervene(dict(d)) for d in specs]
json.dump({"graph": g, "pred": pred}, open(sys.argv[3], "w"), default=float)
"""


def run_model(model: Path, specs: list) -> dict:
    model = Path(model).resolve()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "run.py").write_text(RUNNER)
        (tmp / "in.json").write_text(json.dumps(specs))
        try:
            r = subprocess.run([sys.executable, "-I", "run.py", str(model), "in.json", "out.json"], cwd=tmp, capture_output=True, text=True, timeout=120, env={"OMP_NUM_THREADS": "1"})
        except subprocess.TimeoutExpired:
            raise CannotJudge("the model took longer than 120 s")
        if r.returncode != 0:
            raise CannotJudge("the model crashed: " + (r.stderr.strip().splitlines() or ["no message"])[-1])
        return json.loads((tmp / "out.json").read_text())


def judge(model: Path, truth: dict, heldout: dict, lab: Path | None) -> tuple[bool, str]:
    """(accepted, report). The report's last line is ACCEPTED or REJECTED."""
    p = truth["params"]
    out = run_model(model, heldout["do"])
    try:
        found = {tuple(e) for e in out["graph"]["edges"]}
        conf = {tuple(sorted(e)) for e in out["graph"]["confounded"]}
        assert all(len(e) == 2 for e in found | conf)
    except Exception:
        raise CannotJudge("graph() must return {'edges': [[parent, child], ...], 'confounded': [[a, b], ...]}")
    lines, ok = [], True
    want = set(edges_of(p))
    exact = found == want
    ok &= exact
    lines.append("directed edges: exact" if exact else f"directed edges: {len(want - found)} missing, {len(found - want)} extra")
    want_c = {tuple(sorted(NAMES[i] for i in p["pair"]))}
    exact = conf == want_c
    ok &= exact
    lines.append("confounded pair: exact" if exact else f"confounded pair: {len(want_c - conf)} missing, {len(conf - want_c)} extra")
    errs = []
    for d, pred, mean in zip(heldout["do"], out["pred"], heldout["mean"]):
        for i, n in enumerate(NAMES):
            if n in d:
                continue
            try:
                e = abs(float(pred[n]) - mean[i])
            except Exception:
                e = float("inf")
            errs.append(e if np.isfinite(e) else float("inf"))
    p90 = float(np.percentile(errs, 90))
    passed = p90 <= CAP_PRED
    ok &= passed
    lines.append(f"interventions: p90 absolute error {p90:.3f} (cap {CAP_PRED}) {'ok' if passed else 'too large'}")
    if lab is not None:
        good, used, msg = verify_log(lab, truth["key"], truth["budget"])
        ok &= good
        lines.append(f"experiments: {msg} {'ok' if good else 'REFUSED'}")
    lines.append("ACCEPTED" if ok else "REJECTED")
    return ok, "\n".join(lines)


def load_instance(inst: Path):
    return json.loads((inst / "truth.json").read_text()), json.loads((inst / "heldout.json").read_text())
