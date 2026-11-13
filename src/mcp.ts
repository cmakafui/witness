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

- ask: give a yes/no question, its rule, a probe, and the inputs the probe reads. Witness runs the probe, and the rule decides the answer from what the probe measured.
- The rule is a Cypher expression over the measurements, written before anything runs: $p < 0.01 AND $gain >= 0.1. Each measurement is a parameter, $name. $results is the list of every measurement the run printed: all(r IN $results WHERE r.error <= 0.3). True is yes, false is no. Anything else is failed: a measurement the rule needs is missing or null, or the value is not true or false.
- A probe is a Python script that uv runs. It starts with a PEP 723 header ("# /// script", its dependencies, "# ///"). It measures and does not answer: it prints "WITNESS_RESULT {json object}" for each measurement. It saves files for other questions in the folder $WITNESS_OUT.
- An input is a workspace path, or q-…/name for a file that another question saved. The probe finds each input at that relative path. It finds nothing else.
- When an input changes, Witness runs the question again. A question that reads the output of another question runs again when that output changes. When the inputs change back, the old answer comes back.
- A crash, a timeout, or no measurement is "failed". A failed run is never a "no".
- A probe measures. It never acts: Witness runs it again whenever its inputs change, so a probe that sends, deploys, writes outside $WITNESS_OUT or spends a budget does it again on every rerun. Act yourself, save the result to a file, and ask about the file.
- To test a claim, ask a question whose yes means the claim is wrong, and give the claim's id in disputes. A yes answer that a yes dispute targets is refuted ($refuted in query).
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
      description:
        "Ask a yes/no question and run its probe. The rule decides the answer from the probe's measurements. Returns the answer, the measurements and the saved files. Asking the same question again returns the same question.",
      inputSchema: {
        text: z.string().describe('The question, as one yes/no sentence. Put the conditions in it: "At 8 workers, is …?"'),
        rule: z
          .string()
          .describe("When the answer is yes: a Cypher expression over the measurements, written before anything runs. $name is a measurement, $results all of them: $p < 0.01 AND $gain >= 0.1."),
        probe: z.string().describe('The probe: a uv Python script with a PEP 723 header. It prints WITNESS_RESULT {json object} for each measurement, such as {"p": 0.003, "gain": 0.12}.'),
        inputs: z.array(z.string()).default([]).describe("The files the probe reads: workspace paths, or q-…/name for a file another question saved."),
        disputes: z.array(z.string()).default([]).describe("Ids of questions that a yes to this question shows are wrong."),
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
