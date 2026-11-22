# Python loads this before a probe (src/probe.ts puts this folder on PYTHONPATH). It records each relative path the
# probe tries to read, or to list, that is not in its folder: most often a file the probe needs but did not declare.
# The hub names these paths when the run fails. It sees reads through Python, not reads by other programs.
import os
import sys

_log = os.environ.get("WITNESS_READS")
_seen = set()


def _note(path):
    if isinstance(path, (str, bytes)):
        path = os.fsdecode(path)
        if path and not os.path.isabs(path) and path not in _seen and not os.path.exists(path.split("*")[0] or "."):
            _seen.add(path)
            with open(_log, "a") as f:
                f.write(path + "\n")


def _hook(event, args):
    try:
        if event == "open" and args:
            mode, flags = args[1], args[2] if len(args) > 2 else 0
            reads = mode.startswith("r") if isinstance(mode, str) else not (flags or 0) & (os.O_WRONLY | os.O_RDWR | os.O_CREAT)
            if reads:
                _note(args[0])
        elif event in ("glob.glob", "os.listdir", "os.scandir") and args:
            _note(args[0])
    except Exception:
        pass


if _log:
    sys.addaudithook(_hook)
