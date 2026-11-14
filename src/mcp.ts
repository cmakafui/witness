// The tools agents use, over MCP (streamable HTTP). Each request gets its own server: the hub holds the state.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { SCHEMA } from "./graph.ts";
import { type Hub, Refusal } from "./hub.ts";
import type { Param } from "./relate.ts";
import { VERSION } from "./version.ts";

const GUIDE = `Witness keeps the tested answers of a team of agents in one graph. No agent writes an answer. A probe measures, and a rule decides.

- goal: create an immutable goal that states the solved condition. It starts open and incomplete. Each call creates a new goal.
- ask: give a yes/no question, a rule, a probe, and the files that the probe reads. Witness runs the probe and returns the answer.
- Set rerun: true on the same ask to request another execution with the question and rule unchanged. It appends a Run, even on unchanged inputs or after a failure. Concurrent calls join a queued or running execution. Ordinary asks reuse the latest cached run on the current inputs.
- Set goal to a goal id for exploratory work. The same exploratory question can serve several goals: adding an association reuses its question and runs. Exploratory answers never vote on completion. Set accepts instead to bind a goal's only acceptance question before it runs. The goal is complete only while that question currently answers yes. Changing the acceptance contract requires a new goal.
- The rule is a Cypher expression over the measurements, for example $p < 0.01 AND $gain >= 0.1. $name is a measurement. $results is the list of all measurements. True gives yes. False gives no. All other results give failed.
- The probe is a Python script with a PEP 723 header. uv runs it in an empty folder that holds the declared inputs only. It prints each measurement as WITNESS_RESULT and one JSON object. It saves files for other questions in $WITNESS_OUT.
- An input is a workspace path, or q-…/name for a file that another question saved.
- When an input changes, the question runs again. When the inputs change back, their latest recorded answer comes back. So a probe must not act: do not send, deploy, or use a budget in a probe.
- query: read the graph with Cypher. look: show a file that a run saved.`;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/** Runs a tool. A refusal or a rejected query goes back to the agent as an error it can fix. */
async function tool(fn: () => unknown) {
  try {
    return text(await fn());
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
      description: "Create a new immutable goal with its solved condition. Returns its id and open, incomplete state. Each call creates a new goal, even for the same text. Query first to reuse an existing goal.",
      inputSchema: { text: z.string().describe("The solved condition: what a successful result must satisfy.") },
    },
    ({ text: condition }) => tool(() => hub.goal(condition)),
  );

  s.registerTool(
    "ask",
    {
      description:
        "Ask a yes/no question and run its probe. The rule gives the answer from the measurements. Returns the answer, the measurements and the saved files. The same question asked again is the same question. Set rerun: true to append a fresh execution instead of returning a cached run.",
      inputSchema: {
        text: z.string().describe('The question, as one yes/no sentence with its conditions: "At 8 workers, is …?"'),
        rule: z
          .string()
          .describe("A Cypher expression over the measurements. True gives yes. $name is a measurement. $results is the list of all measurements. Example: $p < 0.01 AND $gain >= 0.1."),
        probe: z.string().describe('A Python script with a PEP 723 header. It prints each measurement as WITNESS_RESULT and one JSON object, for example {"p": 0.003}.'),
        inputs: z.array(z.string()).default([]).describe("The files that the probe reads: workspace paths, or q-…/name for a file that another question saved."),
        goal: z.string().optional().describe("Associate this exploratory question with an existing goal. The same question can serve several goals without another execution. Its answer never determines goal completion. Use either goal or accepts."),
        accepts: z.string().optional().describe("An existing goal id whose only acceptance question this will be. Binds before execution. Only its current yes completes the goal. An identical retry is allowed; a different acceptance question requires a new goal."),
        asker: z.string().optional().describe("Your name or role. Witness shows it and does not use it."),
        timeout_s: z.number().int().positive().max(3600).optional().describe("The time limit of one run, in seconds. Default 600."),
        wait_s: z.number().int().min(0).max(240).optional().describe("The time to wait for the answer, in seconds, at most 240. Default 120. After that, the run continues."),
        rerun: z.boolean().default(false).describe("Request a new execution of this unchanged question, including after a cached failure. Appends a Run; the latest finished run on the current inputs becomes the cached answer. If this question is queued or running, join that execution. Default false."),
      },
    },
    (a) => tool(() => hub.ask({ ...a, timeoutS: a.timeout_s, waitS: a.wait_s })),
  );

  s.registerTool(
    "query",
    {
      description: `Run a read-only Cypher query on the graph. At most 200 rows.\n\n${SCHEMA}`,
      inputSchema: {
        cypher: z.string().describe("A read-only Cypher query."),
        params: z.record(z.string(), z.unknown()).default({}).describe("More parameters for the query."),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => tool(() => hub.query(a.cypher, a.params as Record<string, Param>)),
  );

  s.registerTool(
    "look",
    {
      description: "See a file that a run saved: q-…/name (the file from the question's current run), r-…/name, or a file's SHA-256. Images come back as images.",
      inputSchema: { file: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      try {
        const f = hub.look(file);
        if (f.type.startsWith("image/"))
          return { content: [{ type: "image" as const, data: readFileSync(f.path).toString("base64"), mimeType: f.type.split(";")[0]! }] };
        const body = readFileSync(f.path);
        if (body.includes(0)) return text(`${f.name}: ${f.bytes} bytes of binary data (${f.type}).`);
        const s = body.toString("utf8");
        return text(s.length > 50_000 ? `${s.slice(0, 50_000)}\n… (${f.bytes} bytes; the rest is cut)` : s);
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
