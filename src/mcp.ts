// The tools agents use, over MCP (streamable HTTP). Each request gets its own server: the hub holds the state.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { SCHEMA } from "./graph.ts";
import { type Hub, Refusal } from "./hub.ts";
import type { Param } from "./relate.ts";
import { VERSION } from "./version.ts";

const GUIDE = `Witness keeps the tested answers of a team of agents in one graph. No agent writes an answer. A probe measures, and a rule decides.

- The graph is the only record that agents share. Give other agents question ids and q-…/name paths, not summaries.
- In a new workspace, start with the task. To continue earlier work, query the graph first.
- goal: make a goal that states a solved condition. Goals are optional, and a goal does not change.
- ask: give a yes/no question, a rule, a probe and the files that the probe reads. Witness runs the probe and returns the answer.
- query: read the graph with Cypher. Search it by words before you ask. Another agent may have measured the same thing.
- look: see a file that a run saved.
- watch: wait for new questions and answers in a lane. Pass its cursor back as after.
- The same ask on the same inputs returns the recorded answer. When an input changes, the question runs again. When the inputs change back, their recorded answer comes back. Thus a probe must only measure. It must not send or deploy.
- A run that did not measure (crashed or timed out) settles nothing. The same ask runs it again.
- Never stop a probe process. Let a run you no longer need finish. Only a person on the page can cancel a run.
- Use one short lane name for each direction of work, for example "fourier" or "qr".
- The witness skill tells how to ask well.`;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

// What each tool returns, so a client knows the shape before it calls: code mode can chain calls in one program.
// The SDK checks every result against its schema. The same value also goes out as JSON text, as MCP asks.
const STATE = z.enum(["yes", "no", "failed", "running", "pending", "waiting"]);
const GOAL = z.object({
  id: z.string().describe("The goal id, g-…"),
  text: z.string().describe("The solved condition"),
  acceptance: z.string().nullable().describe("The acceptance question id, or null when none is bound"),
  state: z.union([STATE, z.literal("open")]).describe("The answer of the acceptance question now, or open when the goal has none"),
  complete: z.boolean().describe("True only while the acceptance question answers yes"),
  reason: z.string().nullable().describe("Why the acceptance question failed, or what it waits for"),
});
const ASKED = {
  id: z.string().describe("The question id, q-…"),
  state: STATE.describe("The answer now"),
  run: z.string().nullable().describe("The run that gives the answer, r-…"),
  was: z.enum(["yes", "no"]).nullable().describe("When pending or running: the answer on the inputs before"),
  reason: z.string().nullable().describe("Why it failed, or what it waits for"),
  question: z.string(),
  results: z.array(z.record(z.string(), z.unknown())).describe("The measurements the run printed, in order"),
  saved: z.array(z.string()).describe("The files the run saved, as q-…/name inputs for other questions"),
  goal: GOAL.nullable().describe("With accepts: that goal's completion"),
};
const ROWS = {
  rows: z.array(z.record(z.string(), z.unknown())).describe("One object per row, keyed by the RETURN column names"),
  truncated: z.boolean().describe("True when the query had more than 200 rows"),
};
const LOOKED = {
  name: z.string(),
  file: z.string().describe("The file's SHA-256"),
  type: z.string().describe("Its media type"),
  bytes: z.number().int().describe("Its size in bytes"),
  text: z.string().nullable().describe("Its text, up to 50,000 characters. Null for an image or binary data"),
  truncated: z.boolean().describe("True when text holds only the start of the file"),
};
const WATCHED = {
  events: z
    .array(
      z.object({
        seq: z.number().int().describe("Its place in the recorded order"),
        kind: z.enum(["asked", "answered"]).describe("asked: a new question. answered: a run ended"),
        question: z.string().describe("The question id, q-…"),
        lane: z.string().nullable(),
        answer: z.enum(["yes", "no", "failed"]).optional().describe("answered: the answer of the run"),
        run: z.string().optional().describe("answered: the run id, r-…"),
      }),
    )
    .describe("What happened, oldest first. 100 at most"),
  cursor: z.number().int().describe("Give it as after in the next watch"),
};
const LIMIT = 50_000;

/** A result with its structured value, and the same value as JSON text. */
const structured = (value: Record<string, unknown>) => ({ ...text(value), structuredContent: value });

/** Runs a tool. A refusal or a rejected query goes back to the agent as an error it can fix. */
async function tool(fn: () => unknown) {
  try {
    return structured((await fn()) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof Refusal || (e as Error).name === "RelateError") return { ...text((e as Error).message), isError: true };
    throw e;
  }
}

function server(hub: Hub): McpServer {
  const instructions = `${GUIDE}\n- This hub runs ${hub.jobs} probes at the same time. More asks wait in line.`;
  const s = new McpServer({ name: "witness", version: VERSION }, { instructions });

  s.registerTool(
    "goal",
    {
      description: "Make a goal that states a solved condition. Returns its id. The goal starts open and not complete. Each call makes a new goal, also for the same text. To continue earlier work, query the goals that exist.",
      inputSchema: { text: z.string().describe("The solved condition: what a good result must satisfy.") },
      outputSchema: GOAL.shape,
    },
    ({ text: condition }) => tool(() => hub.goal(condition)),
  );

  s.registerTool(
    "ask",
    {
      description:
        "Ask a yes/no question. Witness runs its probe and returns the answer, the measurements and the saved files. Give probe or probe_ref, not both. The same ask again returns the answer on the current inputs. If the run did not measure (crashed or timed out), the same ask runs it again.",
      inputSchema: {
        text: z.string().describe('The question, as one yes/no sentence with its conditions. Example: "At 8 workers, is the sort faster than at 1 worker?"'),
        rule: z
          .string()
          .describe("A Cypher expression over the measurements. $name is the last value of a measurement. $results is the list of all measurement objects. True gives yes. False gives no. Any other value gives failed. Example: $p < 0.01 AND $gain >= 0.1"),
        probe: z
          .string()
          .optional()
          .describe('A Python script with a PEP 723 header. uv runs it in an empty folder that holds only the inputs. It prints each measurement as WITNESS_RESULT and one JSON object, for example WITNESS_RESULT {"p": 0.003}. It saves files for other questions in $WITNESS_OUT. If it installs packages, it sets exclude-newer under [tool.uv] to a fixed date.'),
        probe_ref: z.string().optional().describe("The id of a question in this workspace (q-…). Witness uses the probe of that question. Give the rule and the inputs of this question."),
        inputs: z
          .array(z.string())
          .default([])
          .describe("The files that the probe reads. Each input is a workspace path, q-…/name (a file that another question saved), or q-… (the recorded answer and measurements of another question, mounted as q-….json). An acceptance question cannot read files in scratch/."),
        accepts: z
          .string()
          .optional()
          .describe("The id of a goal. This question becomes the acceptance question of the goal before it runs. A goal has only one acceptance question. Only its yes now makes the goal complete. The same ask again is allowed. A different acceptance question needs a new goal."),
        replaces: z
          .string()
          .optional()
          .describe("The id of a question whose run did not measure (crashed or timed out). Use it when this question fixes that probe. Witness refuses a question whose run measured. The old answer stays, and queries get the old question in $replaced."),
        lane: z
          .string()
          .optional()
          .describe("A short name for your direction of work: 1 or 2 words, for example 'switches' or 'qr'. Use the same lane for all questions in that direction. It does not change the answer. A question keeps the lane of its first ask."),
        timeout_s: z.number().int().positive().max(3600).optional().describe("The time limit of one run, in seconds. The default is 600."),
        wait_s: z.number().int().min(0).max(240).optional().describe("How long to wait for the answer, in seconds. The maximum is 240, and the default is 120. After that time, the run continues."),
      },
      outputSchema: ASKED,
    },
    (a) => tool(() => hub.ask({ ...a, probeRef: a.probe_ref, timeoutS: a.timeout_s, waitS: a.wait_s })),
  );

  s.registerTool(
    "watch",
    {
      description:
        "Wait for what happens in a lane: an agent asks a question, or a run ends with its answer. Returns as soon as there is an event, or with no events after wait_s. Give the returned cursor as after in the next watch, and you miss nothing. An event holds ids only: use query and look for the detail.",
      inputSchema: {
        lane: z.string().optional().describe("The lane to watch. Without it, watch every lane."),
        after: z.number().int().min(0).optional().describe("The cursor from the last watch. Without it, watch from now."),
        wait_s: z.number().int().min(0).max(240).optional().describe("How long to wait for an event, in seconds. The maximum is 240, and the default is 120."),
      },
      outputSchema: WATCHED,
      annotations: { readOnlyHint: true },
    },
    (a) => tool(() => hub.watch({ after: a.after, lane: a.lane, waitS: a.wait_s })),
  );

  registerReadTools(s, hub);
  return s;
}

export type ReadOnlyStore = Pick<Hub, "query" | "look">;

function registerReadTools(s: McpServer, store: ReadOnlyStore) {
  s.registerTool(
    "query",
    {
      description: `Run a read-only Cypher query on the graph. Returns 200 rows at most.\n\n${SCHEMA}`,
      inputSchema: {
        cypher: z.string().describe("A read-only Cypher query."),
        params: z.record(z.string(), z.unknown()).default({}).describe("More query parameters."),
      },
      outputSchema: ROWS,
      annotations: { readOnlyHint: true },
    },
    (a) => tool(() => store.query(a.cypher, a.params as Record<string, Param>)),
  );

  s.registerTool(
    "look",
    {
      description: "See a file that a run saved. Give q-…/name (from the current run of the question), r-…/name, or the SHA-256 of the file. An image comes back as an image.",
      inputSchema: { file: z.string() },
      outputSchema: LOOKED,
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      try {
        const f = store.look(file);
        const meta = { name: f.name, file: basename(f.path), type: f.type, bytes: f.bytes };
        const body = readFileSync(f.path);
        if (f.type.startsWith("image/"))
          return {
            content: [{ type: "image" as const, data: body.toString("base64"), mimeType: f.type.split(";")[0]! }],
            structuredContent: { ...meta, text: null, truncated: false },
          };
        if (body.includes(0)) {
          const value = { ...meta, text: null, truncated: false };
          return { content: [{ type: "text" as const, text: `${f.name}: ${f.bytes} bytes of binary data (${f.type}).` }], structuredContent: value };
        }
        const all = body.toString("utf8");
        const value = { ...meta, text: all.slice(0, LIMIT), truncated: all.length > LIMIT };
        const shown = value.truncated ? `${value.text}\n… (${f.bytes} bytes. The rest is cut.)` : all;
        return { content: [{ type: "text" as const, text: shown }], structuredContent: value };
      } catch (e) {
        if (e instanceof Refusal) return { ...text(e.message), isError: true };
        throw e;
      }
    },
  );
}

function readOnlyServer(store: ReadOnlyStore): McpServer {
  const s = new McpServer({ name: "witness-replay", version: VERSION }, {
    instructions: "A read-only view of a recorded Witness graph. Use query (Cypher) and look (saved files). This view cannot make goals or run probes.",
  });
  registerReadTools(s, store);
  return s;
}

/** Handles each MCP request with a new server from make. */
const handler = (make: () => McpServer) => async (req: Request): Promise<Response> => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await make().connect(transport);
  return transport.handleRequest(req);
};

/** MCP for agents: all five tools. */
export const mcp = (hub: Hub) => handler(() => server(hub));

/** MCP for witness replay: query and look only. */
export const readOnlyMcp = (store: ReadOnlyStore) => handler(() => readOnlyServer(store));
