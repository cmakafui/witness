# Witness

AI agents do research together. Each finding is a yes/no question that a uv probe answers. A Relate graph keeps the questions, the runs and the answers. You can watch the graph and query it. The README has the goal, the graph and the build order.

## Rules

- Nothing writes an answer. An answer comes only from a run.
- The graph holds questions and their evidence. It does not hold agents.
- The hub never changes or deletes a record. It only creates records. The answer to a question comes from its runs and from the inputs as they are now.
- The hub is the only process that writes to Relate. Probes never touch the store.
- Keep it small. Build the next step of the build order and nothing more.
- Write plain English: short sentences, active voice, no jargon.

## Commands

- `bun test`: the hub with real uv probes, MCP, the page in a real browser engine, the schema (needs `uv`, and macOS WebKit or Chrome for `Bun.WebView`). About 3 seconds once uv's cache is warm.
- People get three commands: `setup`, `open [DIR]`, `replay [DIR]`. Keep it at three. `mcp` and `serve` are plumbing.
- `bun src/main.ts mcp`: MCP over stdio for one agent. It finds the workspace's hub (`.witness/hub.json`) or starts one in the background with `--idle 600`, keeps it alive with a heartbeat, and starts a new one if it goes away.
- `bun src/main.ts serve --root DIR`: a hub in the foreground. `--idle 0` (the default here) never exits.
- The skill is `skill/witness/`. `witness setup` links it into `~/.claude/skills`. Change the skill when a tool or the probe format changes.

## Code

- `src/hub.ts`: the only writer. It works out each answer from the runs and the inputs now, and reruns what changed.
- `src/probe.ts`: runs one probe with uv in a folder that holds only its declared inputs.
- `src/graph.ts`: the records and the Cypher that writes them. The hub (ffi) and the page (WASM) both use it.
- `src/mcp.ts`, `src/server.ts`, `src/main.ts`: the three tools, one `Bun.serve`, the CLI.
- `src/connect.ts`: finds or starts a workspace's hub, and bridges stdio MCP to it. `src/setup.ts`: `witness setup`.
- `src/replay.ts`: `witness replay` plays a store back to the page, read-only. `bun run demo` replays `examples/causal-hunt`.
- `examples/causal-hunt/` is a recorded session for the hackathon judges. Never write to its store: a new session goes in a new folder.
- The page’s Play/Pause/Previous/Next tour visits all questions by seq, including no and failed answers, with five seconds to read each result. It waits for incoming replay records and ends at the last question.
- `page/`: the live page. It answers its panels with Cypher on its own Relate WASM copy.
- `page/tools.ts`: the page's WebMCP tools for a browser agent, `query`, `show_question` and `navigate`. Navigation uses Motion: camera, paths, then the evidence panel. It awaits completion, supports interruption and reduced motion; overview clears the focus. They only read: a query whose plan has any operator outside `READS` is refused. `ask` never goes in the page.
- `SCHEMA` in `src/graph.ts` describes the graph to agents. The MCP `query` tool and the page's `query` tool both use it.
- An answer is never stored. Queries get the answers as parameters (`answerParams` in `src/graph.ts`).
- `bun check`: type check. Run both before you commit.

## Relate

- `src/relate.ts` opens Relate with `bun:ffi` (C ABI v2). It does not use the koffi client. Bun blocks koffi's install script, and that is correct.
- `by` and `as` are reserved words in Cypher. Do not use them as property names.
- A second process cannot open a store for writing. It can open it read-only.

# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Type checking

Use `bun check` to type check the project. It reads `tsconfig.json` and reports the same errors as `tsc`.

- `bun check src/index.ts` checks one file and what it imports
- `bun --check src/index.ts`, `bun test --check` and `bun build --check` type check first, and do nothing else if there is an error

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
