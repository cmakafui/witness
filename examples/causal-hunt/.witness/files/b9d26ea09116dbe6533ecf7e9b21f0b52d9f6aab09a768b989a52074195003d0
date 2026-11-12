# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Judge a saved model on the held-out interventions the agents never saw, and read the lab's experiment log.

usage: uv run --script vault/causal-hunt/check.py <lab dir> <model.py>      judge one model
       uv run --script vault/causal-hunt/check.py <lab dir> --controls      the true model must be accepted; eight wrong ones rejected

A model is a Python file with `graph()` -> {'edges': [[parent, child], ...], 'confounded': [[a, b], ...]} and
`intervene(do)` -> {variable: expected value} for all six variables; numpy and the standard library only.
Exit 0 = accepted, 1 = a completed rejection, 2 = the judge could not decide (a model that crashes or times out is never a "rejection").
The instance (truth and held-out set) is read from vault/causal-hunt/instance/ (CAUSAL_HUNT_INSTANCE overrides, for other seeds).
"""
import csv
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import scm  # noqa: E402

INSTANCE = Path(os.environ.get("CAUSAL_HUNT_INSTANCE") or Path(__file__).parent / "instance")


def observational(lab: Path):
    rows = list(csv.reader((lab / "observational.csv").open()))[1:]
    return np.array([[float(x) for x in r] for r in rows])


def controls(lab: Path, p: dict, tmp: Path) -> list[tuple[str, Path, Path | None, str]]:
    """(name, model, lab for the log check or None, expected verdict)."""
    edges, conf = scm.edges_of(p), [tuple(scm.NAMES[i] for i in p["pair"])]
    B, c = p["B"], p["c"]
    X = observational(lab)
    mu, sigma = X.mean(axis=0).tolist(), np.cov(X.T).tolist()
    flipped = [(edges[0][1], edges[0][0])] + edges[1:]
    scaled = (np.array(B) * 1.3).tolist()
    specs = [
        ("true model", scm.model_source(edges, conf, B, c), None, "ACCEPTED"),
        ("one edge reversed", scm.model_source(flipped, conf, B, c), None, "REJECTED"),
        ("one edge missing", scm.model_source(edges[1:], conf, B, c), None, "REJECTED"),
        ("confounder not declared", scm.model_source(edges, [], B, c), None, "REJECTED"),
        ("a wrong pair declared confounded", scm.model_source(edges, [(scm.NAMES[0], scm.NAMES[1])] if (0, 1) != tuple(p["pair"]) else [(scm.NAMES[2], scm.NAMES[3])], B, c), None, "REJECTED"),
        ("effects read from passive data", scm.model_source(edges, conf, mu=mu, sigma=sigma, mode="conditional"), None, "REJECTED"),
        ("no variable moves anything", scm.model_source(edges, conf, mu=mu, mode="baseline"), None, "REJECTED"),
        ("true graph, effects 30% too strong", scm.model_source(edges, conf, scaled, c), None, "REJECTED"),
    ]
    out = []
    for i, (name, src, lab_for_log, want) in enumerate(specs):
        f = tmp / f"control{i}.py"
        f.write_text(src)
        out.append((name, f, lab_for_log, want))
    # the budget: the true model, with a log that went over budget, or one edited by hand
    true = out[0][1]
    over, edited = tmp / "over", tmp / "edited"
    over.mkdir(), edited.mkdir()
    scm.write_log(over / scm.LOG, [({"x1": 1.0}, 100)] * (scm.BUDGET + 1), "KEY")
    return out, true, over, edited


def main() -> int:
    lab, arg = Path(sys.argv[1]).resolve(), sys.argv[2]
    truth, heldout = scm.load_instance(INSTANCE)
    if arg != "--controls":
        ok, report = scm.judge(Path(arg).resolve(), truth, heldout, lab)
        print(report)
        return 0 if ok else 1
    failed = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        out, true, over, edited = controls(lab, truth["params"], tmp)
        # logs built with the real key, so only the budget or the edit makes them fail
        scm.write_log(over / scm.LOG, [({"x1": 1.0}, 100)] * (scm.BUDGET + 1), truth["key"])
        scm.write_log(edited / scm.LOG, [({"x1": 1.0}, 100)] * 3, truth["key"])
        text = (edited / scm.LOG).read_text().replace('"rows": 100', '"rows": 101', 1)
        (edited / scm.LOG).write_text(text)
        ok_lab = tmp / "ok"
        ok_lab.mkdir()
        scm.write_log(ok_lab / scm.LOG, [({"x1": 1.0}, 100)] * scm.BUDGET, truth["key"])
        cases = [(n, m, None, w) for n, m, _, w in out]
        cases += [("true model, exactly the budget", true, ok_lab, "ACCEPTED"), ("true model, one experiment over budget", true, over, "REJECTED"), ("true model, log edited by hand", true, edited, "REJECTED")]
        for name, model, log_lab, want in cases:
            ok, report = scm.judge(model, truth, heldout, log_lab)
            verdict = report.splitlines()[-1]  # the printed verdict, not just the exit code
            good = verdict == want
            print(f"{'ok  ' if good else 'FAIL'} {name}: {verdict}")
            if not good:
                failed.append(name)
    print("controls pass" if not failed else "controls FAILED: " + ", ".join(failed))
    return 2 if failed else 0  # a judge whose controls fail can't be trusted: not a rejection


try:
    code = main()
except scm.CannotJudge as e:
    print(f"cannot judge: {e}", file=sys.stderr)
    code = 2
except BaseException as e:  # any crash is exit 2: an uncaught exception also exits 1 and would pass for a rejection
    print(f"cannot judge: {e!r}", file=sys.stderr)
    code = 2
sys.exit(code)
