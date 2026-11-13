# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""A Witness probe. It measures; the rule decides.

Ask it with the question, the rule and every file it reads as an input.
The rule, written before anything runs, as a Cypher expression over the measurements: $count > 0
"""
import json
import os

OUT = os.environ["WITNESS_OUT"]  # save files here for other questions to read as q-…/name

# 1. Read the inputs, at the paths you declared.
data = open("data.txt").read().split()

# 2. Check that the measurement can happen. Crash if it cannot: a crash is "failed", never "no".
assert data, "no data: the measurement did not happen"

# 3. Measure. Print each measurement as a JSON object. The rule reads each name as $name.
count = len(data)
print("WITNESS_RESULT", json.dumps({"count": count}))

# 4. Save what others can build on.
with open(os.path.join(OUT, "summary.json"), "w") as f:
    json.dump({"count": count}, f)
