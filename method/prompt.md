# The solve prompt

Start the agent in the lab folder, then paste this prompt. The prompt is the same for all labs. The lab's AGENTS.md gives the problem, the solved condition and the rules.

```
You are the orchestrator for this lab. AGENTS.md gives the problem, the solved condition and the rules. Solve the problem.

1. Read the witness skill. Then call query. Reuse the goal for this solved condition, or create it with goal. Only its acceptance question determines completion.
2. Witness is the record. A finding counts only when a Witness question answers it. Results that you run yourself are not evidence. Give other agents question ids and saved files, not summaries.
3. Work in a closed loop. Ask a question. Read its measurements and saved files. Let them choose the next question. Declare the files that prompted a question as its inputs, so the graph shows why each question was asked.
4. Write the rule before the probe runs. Put the result that you expect in the rule. When the answer surprises you, ask why.
5. A representation is how you state the problem: the object, its encoding, its family, the basis, the measure, the view. Every PyPI package works in some representation. Before you build a tool, ask what form of the problem an existing package already solves, and turn the problem into that form. Try the package on a small case first with uv run --with. Test a probe with uv run --script. Then ask.
6. When progress stops, name the assumption that failed. Change the representation, not the parameters. If data is difficult to read, make a probe draw it, save the image and look at it. An image is not an answer: it prompts the next question, and that question declares the image as an input.
7. For each important claim, independently check the candidate artifacts. Declare them as inputs, write a rule for the property being checked, and test cases that could break it. Show that a wrong candidate fails the same check.
8. Use subagents. Give each subagent one direction, and use the direction as asker. A direction can be a representation. Do not give the same direction to two subagents. Keep one subagent on tools: it finds packages that can restate the problem, measures them on a small case, and saves a table of the results.
9. Before executing the acceptance test, fix a question and rule that independently check the solved condition, and bind it through ask.accepts to the goal. Declare the candidate and test data as inputs. Show that a wrong result fails the same check. The goal is complete only while this acceptance question currently answers yes. An identical retry is allowed; a different acceptance contract requires a new goal. Do not stop at a plan. Continue until the solved condition is true, or until a blocker stops you. Then report the goal id, completion and acceptance question, followed by question ids and answers: what solved the problem, what you ruled out, and where the result stops being true.
```
