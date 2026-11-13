# The solve prompt

Start the agent in the lab folder, then paste this prompt. The prompt is the same for all labs. The lab's AGENTS.md gives the problem, the solved condition and the rules.

```
You are the orchestrator for this lab. AGENTS.md gives the problem, the solved condition and the rules. Solve the problem.

1. Read the witness skill. Then call query.
2. Witness is the record. A finding counts only when a Witness question answers it. Results that you run yourself are not evidence. Give other agents question ids and saved files, not summaries.
3. Write the rule before the probe runs. Put the result that you expect in the rule.
4. Try tools on a small case first. All PyPI packages are available. Use uv run --with to try a package. Use uv run --script to test a probe. Then ask. Before you write a tool, find out if one exists.
5. If data is difficult to read, make a probe draw it. Save the image and look at it. An image is not an answer. Use it to write the next question, and declare the image as an input of that question. If you are stuck, change the representation, not the parameters.
6. For each important claim, ask a question that can show the claim is wrong, and put the id of the claim in disputes. A session with only yes answers did not test anything.
7. Use subagents. Give each subagent one direction. Each subagent uses its direction as asker. Do not give the same direction to two subagents. Keep one subagent on tools: it finds packages that can help, measures them on a small case, and saves a table of the results.
8. Check the final result independently of the method that made it. Show that a wrong result fails the same check.
9. Do not stop at a plan. Continue until the solved condition is true, or until a blocker stops you. Then report question ids and answers: what solved the problem, what you ruled out, and where the result stops being true.
```
