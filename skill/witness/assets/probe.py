# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""A Witness probe. It measures. The rule decides. Example rule: $count > 0"""
import json
import os

data = open("data.txt").read().split()  # a declared input
assert data, "no data"  # no measurement: the run fails, it does not give "no"

count = len(data)
print("WITNESS_RESULT", json.dumps({"count": count}))

with open(os.path.join(os.environ["WITNESS_OUT"], "summary.json"), "w") as f:
    json.dump({"count": count}, f)  # a file that other questions can read as q-…/summary.json
