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

- The graph is the only record agents share. Give another agent question ids and saved files, not summaries.
- In a fresh workspace, start with the task. Query the graph when resuming or looking for prior work to build on.
- goal: create an immutable goal that states a solved condition. A goal is optional, and the work can have many. It starts open and incomplete. Each call creates a new goal.
- ask: give a yes/no question, a rule, a probe, and the files that the probe reads. Witness runs the probe and returns the answer.
- Use probe_ref in place of probe to reuse the exact script from an existing question. Supply the new question's rule and inputs.
- The same ask on unchanged inputs returns the cached answer. A run that measured is final for its inputs. A run that crashed or timed out is not: the same ask runs it again. Concurrent asks join one execution.
- Set accepts to a goal id to bind that goal's only acceptance question before it runs. The goal is complete only while that question currently answers yes. No other question votes on completion. Changing the acceptance contract requires a new goal.
- The rule is a Cypher expression over the measurements, for example $p < 0.01 AND $gain >= 0.1. $name is a measurement. $results is the list of all measurements. True gives yes. False gives no. All other results give failed.
- The probe is a Python script with a PEP 723 header. A probe with dependencies sets exclude-newer under [tool.uv] to a fixed date, keeping the package upload cutoff in the probe text. uv runs it in an empty folder that holds the declared inputs only. It prints each measurement as WITNESS_RESULT and one JSON object. It saves files for other questions in $WITNESS_OUT.
- An input is a workspace path, or q-…/name for a file that another question saved.
- When an input changes, the question runs again. When the inputs change back, their latest recorded answer comes back. So a probe must not act: do not send or deploy in a probe.
- Set replaces to the id of a question whose run crashed or timed out when you fix its probe. Witness refuses it for a measured answer. The old question stays failed and goes into $replaced.
- query: read the graph with Cypher. look: show a file that a run saved.`;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

// What each tool returns, so a client knows the shape before it calls: code mode can chain calls in one program.
// The SDK checks every result against its schema. The same value also goes out as JSON text for older clients.
const STATE = z.enum(["yes", "no", "failed", "running", "pending", "waiting"]);
const GOAL = z.object({
  id: z.string().describe("The goal id, g-…"),
  text: z.string().describe("The solved condition"),
  acceptance: z.string().nullable().describe("The acceptance question id, or null when none is bound"),
  state: z.union([STATE, z.literal("open")]).describe("The acceptance question's answer now; open when none is bound"),
  complete: z.boolean().describe("True only while the acceptance question answers yes"),
  reason: z.string().nullable(),
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
  text: z.string().nullable().describe("Its text, up to 50,000 characters; null for an image or binary data"),
  truncated: z.boolean().describe("True when text holds only the start of the file"),
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
  const s = new McpServer({ name: "witness", version: VERSION }, { instructions: GUIDE });

  s.registerTool(
    "goal",
    {
      description: "Create a new immutable goal with its solved condition. Returns its id and open, incomplete state. Each call creates a new goal, even for the same text. When resuming, query to find an existing goal.",
      inputSchema: { text: z.string().describe("The solved condition: what a successful result must satisfy.") },
      outputSchema: GOAL.shape,
    },
    ({ text: condition }) => tool(() => hub.goal(condition)),
  );

  s.registerTool(
    "ask",
    {
      description:
        "Ask a yes/no question and run its probe. Supply exactly one of probe or probe_ref. Returns the answer, the measurements and the saved files. The same question asked again returns its answer on the current inputs, or retries a run that crashed or timed out.",
      inputSchema: {
        text: z.string().describe('The question, as one yes/no sentence with its conditions: "At 8 workers, is …?"'),
        rule: z
          .string()
          .describe("A Cypher expression over the measurements. True gives yes. $name is a measurement. $results is the list of all measurements. Example: $p < 0.01 AND $gain >= 0.1."),
        probe: z.string().optional().describe('A Python script with a PEP 723 header. It prints each measurement as WITNESS_RESULT and one JSON object, for example {"p": 0.003}.'),
        probe_ref: z.string().optional().describe("An existing question id (q-…) in this workspace. Reuses its exact probe script. Supply this question's own rule and inputs."),
        inputs: z.array(z.string()).default([]).describe("The files that the probe reads: workspace paths, or q-…/name for a file that another question saved."),
        accepts: z.string().optional().describe("An existing goal id whose only acceptance question this will be. Binds before execution. Only its current yes completes the goal. An identical retry is allowed; a different acceptance question requires a new goal."),
        replaces: z
          .string()
          .optional()
          .describe("The id of a question whose run crashed or timed out, when this question is its fix. Witness refuses it for a question that measured. The old answer stays; queries get it in $replaced."),
        asker: z.string().optional().describe("Your direction of work, for example the approach you test. The page gives each direction its own row. It does not change the answer."),
        timeout_s: z.number().int().positive().max(3600).optional().describe("The time limit of one run, in seconds. Default 600."),
        wait_s: z.number().int().min(0).max(240).optional().describe("The time to wait for the answer, in seconds, at most 240. Default 120. After that, the run continues."),
      },
      outputSchema: ASKED,
    },
    (a) => tool(() => hub.ask({ ...a, probeRef: a.probe_ref, timeoutS: a.timeout_s, waitS: a.wait_s })),
  );

  s.registerTool(
    "query",
    {
      description: `Run a read-only Cypher query on the graph. At most 200 rows.\n\n${SCHEMA}`,
      inputSchema: {
        cypher: z.string().describe("A read-only Cypher query."),
        params: z.record(z.string(), z.unknown()).default({}).describe("More parameters for the query."),
      },
      outputSchema: ROWS,
      annotations: { readOnlyHint: true },
    },
    (a) => tool(() => hub.query(a.cypher, a.params as Record<string, Param>)),
  );

  s.registerTool(
    "look",
    {
      description: "See a file that a run saved: q-…/name (the file from the question's current run), r-…/name, or a file's SHA-256. Images come back as images.",
      inputSchema: { file: z.string() },
      outputSchema: LOOKED,
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      try {
        const f = hub.look(file);
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
        const shown = value.truncated ? `${value.text}\n… (${f.bytes} bytes; the rest is cut)` : all;
        return { content: [{ type: "text" as const, text: shown }], structuredContent: value };
      } catch (e) {
        if (e instanceof Refusal) return { ...text(e.message), isError: true };
        throw e;
      }
    },
  );
  return s;
}

/** Handles one MCP request. */
export function mcp(hub: Hub) {
  return async (req: Request): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server(hub).connect(transport);
    return transport.handleRequest(req);
  };
}
