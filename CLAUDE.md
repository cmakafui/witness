# Witness

AI agents do research together. Each finding is a yes/no question with a rule. A uv probe measures, and the rule, a Cypher expression over the measurements, decides. A Relate graph keeps the questions and their runs. You can watch the graph and query it. The README has the goal and the graph.

## Rules

- Nothing writes an answer. An answer comes only from a run: the question's rule on the run's measurements. A probe never answers.
- The graph holds questions and their evidence. It does not hold agents.
- The hub never changes or deletes a record. It only creates records. The answer to a question comes from its runs and from the inputs as they are now.
- The hub is the only process that writes to Relate. Probes never touch the store.
- Keep it small. Build what the task needs and nothing more.
- Write plain English: short sentences, active voice, no jargon.

## Commands

Use Bun for dependency installation, scripts, tests and builds. Bundle the page with Bun’s HTML imports.

- `bun test`: the hub with real uv probes, MCP, the page in a real browser engine, the schema (needs `uv`, and macOS WebKit or Chrome for `Bun.WebView`).
- People get three commands: `setup`, `open [DIR]`, `replay [DIR]`. Keep it at three. `mcp` and `serve` are plumbing.
- `bun src/main.ts mcp`: MCP over stdio for one agent. It finds the workspace's hub (`.witness/hub.json`) or starts one in the background with `--idle 600`, keeps it alive with a heartbeat, and starts a new one if it goes away.
- `bun src/main.ts serve --root DIR`: a hub in the foreground. `--idle 0` (the default here) never exits.
- The skill is `skill/witness/`. `witness setup` links it into `~/.claude/skills`. Change the skill when a tool or the probe format changes. The skill teaches the tool. The working method goes in `method/prompt.md`, the same prompt for every lab.

## Code

- `src/hub.ts`: the only writer. It evaluates each rule with Relate on an empty in-memory store, writes a run once when it ends, works out each answer from the runs and the inputs now, and reruns what changed.
- `src/probe.ts`: runs one probe with uv in a folder that holds only its declared inputs.
- Probes use one asynchronous `uv run --script`. Keep structured measurements and a bounded diagnostic tail for failures. Archive only declared inputs and saved outputs.
- `src/graph.ts`: the two records (Question, Run) and the Cypher that writes them, and what a rule may be. The hub (ffi) and the page (WASM) both use it.
- `src/mcp.ts`, `src/server.ts`, `src/main.ts`: the three tools, one `Bun.serve`, the CLI.
- `src/connect.ts`: finds or starts a workspace's hub, and bridges stdio MCP to it. `src/setup.ts`: `witness setup`.
- `src/replay.ts`: `witness replay` loads a recorded store into the page, read-only. It sends the whole graph and each question’s latest recorded run immediately. The page provides manual question navigation.
- A recorded session for the hackathon judges goes in `examples/`. Never write to a recorded store: a new session goes in a new folder.
- The page’s Previous, Next and timeline controls visit all questions by seq, including no and failed answers. Their position follows the selected question, including graph clicks and WebMCP navigation. Keep navigation manual.
- `page/`: the live page. It answers its panels with Cypher on its own Relate WASM copy. Lanes: one row per asker direction, questions left to right by seq. The evidence panel splits the rule at its top-level ANDs (`clauses` in `src/graph.ts`) and shows each part true, false or not measured. The answer still comes from the run.
- `page/DESIGN.md`: the page's tokens and rules (Google's DESIGN.md format). Change it with the page. Page text is labels, not sentences.
- `page/tools.ts`: the page's WebMCP tools for a browser agent, `query`, `show_question` and `navigate`. Navigation immediately shows the question, its dependencies and its evidence; overview clears the focus. They only read: a query whose plan has any operator outside `READS` is refused. `ask` never goes in the page.
- `SCHEMA` in `src/graph.ts` describes the graph to agents. The MCP `query` tool and the page's `query` tool both use it.
- An answer is never stored. Queries get the answers as parameters (`answerParams` in `src/graph.ts`).
- `bun check`: type check. Run both before you commit.

## Relate

- `src/relate.ts` opens Relate with `bun:ffi` (C ABI v2). It does not use the koffi client. Bun blocks koffi's install script, and that is correct.
- `by` and `as` are reserved words in Cypher. Do not use them as property names.
- A second process cannot open a store for writing. It can open it read-only.
