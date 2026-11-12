// The three tools agents use, over MCP (streamable HTTP). Each request gets its own server: the hub holds the state.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { SCHEMA } from "./graph.ts";
import { type Hub, Refusal } from "./hub.ts";
import type { Param } from "./relate.ts";
import { VERSION } from "./version.ts";

const GUIDE = `Witness keeps the tested answers of a team of agents in one graph. A finding counts only when a run answers it.

- ask: give a yes/no question, the rule that decides it, a probe, and the inputs the probe reads. Witness runs the probe and returns the answer.
- A probe is a Python script that uv runs. It starts with a PEP 723 header ("# /// script", its dependencies, "# ///"). It prints "WITNESS_RESULT {json}" for each measurement and "WITNESS_ANSWER yes" or "WITNESS_ANSWER no" exactly once. It saves files for other questions in the folder $WITNESS_OUT.
- An input is a workspace path, or q-…/name for a file that another question saved. The probe finds each input at that relative path. It finds nothing else.
- When an input changes, Witness runs the question again. A question that reads the output of another question runs again when that output changes. When the inputs change back, the old answer comes back.
- A crash, a timeout, or a missing answer is "failed". A failed run is never a "no".
- A probe measures. It never acts: Witness runs it again whenever its inputs change, so a probe that sends, deploys, writes outside $WITNESS_OUT or spends a budget does it again on every rerun. Act yourself, save the result to a file, and ask about the file.
- Write the rule before anything runs. Check that the measurement happened before you answer: crash if it did not.
- To test a claim, ask a question that tries to show it is wrong, and give the claim's id in disputes.
- query: read the graph with Cypher. look: see a file that a run saved.`;

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
    "ask",
    {
      description: "Ask a yes/no question and run its probe. Returns the answer, the results and the saved files. Asking the same question again returns the same question.",
      inputSchema: {
        text: z.string().describe('The question, as one yes/no sentence. Put the conditions in it: "At 8 workers, is …?"'),
        rule: z.string().describe('The rule that decides yes or no, written before anything runs: "yes when p < 0.01 and the gain is at least 10%".'),
        probe: z.string().describe("The probe: a uv Python script with a PEP 723 header. It prints WITNESS_ANSWER yes or no exactly once."),
        inputs: z.array(z.string()).default([]).describe("The files the probe reads: workspace paths, or q-…/name for a file another question saved."),
        disputes: z.array(z.string()).default([]).describe("Ids of questions whose answer this question tries to show is wrong."),
        asker: z.string().optional().describe("Who asks: your name or role. Only for display."),
        timeout_s: z.number().int().positive().max(3600).optional().describe("How long one run may take. Default 600."),
        wait_s: z.number().int().min(0).max(240).optional().describe("How long to wait for the answer, at most 240 seconds. Default 120. The run goes on after."),
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
