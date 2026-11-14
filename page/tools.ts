/// <reference lib="dom" />
// The page's tools for an agent in the browser (WebMCP): the person asks it about the graph, and it answers with the
// page's own Cypher and shows what it found. These tools only read. An agent in the browser can never ask a question:
// asking runs code on this machine, so `ask` stays with the agents on /mcp.
import { SCHEMA, type Status } from "../src/graph.ts";

/** What the tools need from the page. */
export type Page = {
  /** The operators of a query's plan. */
  operators(cypher: string): string[];
  /** Shows the query in the search bar, runs it there, and returns its rows or its error. */
  query(cypher: string): { columns: string[]; rows: Record<string, unknown>[] } | Error;
  /** Selects the question in the graph and returns what its panel shows, or null when there is no such question. */
  question(id: string): (Record<string, unknown> & { status: Status | undefined; read: { name: string; url: string }[]; saved: { name: string; url: string }[] }) | null;
};

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(args: Record<string, unknown>): Promise<string>;
};

/** The plan operators of a query that only reads. A CALL subquery hides its body from the plan, so it is not here. */
const READS = new Set(["ProduceResults", "Projection", "AllNodesScan", "NodeByLabelScan", "Expand", "Optional", "EagerAggregation", "Unwind", "Union"]);
const LIMIT = 200;

// Every question, rule and result was written by an agent, so the tools mark what they return as untrusted.
const hints = { readOnlyHint: true, untrustedContentHint: true };

/**
 * A tool's reply, as JSON. A refusal is a reply too, {refused: why}: Chrome hides the message of a tool that throws,
 * and the agent needs it to fix its call, as on /mcp.
 */
const reply =
  (fn: (args: Record<string, unknown>) => unknown) =>
  async (args: Record<string, unknown>): Promise<string> => {
    try {
      return JSON.stringify(await fn(args));
    } catch (e) {
      return JSON.stringify({ refused: (e as Error).message });
    }
  };

export function webTools(page: Page): Tool[] {
  return [
    {
      name: "query",
      description: `Run a read-only Cypher query on the Witness graph in this page, and show it to the person in the search bar. $selected is the question the person has selected. At most ${LIMIT} rows.\n\n${SCHEMA}`,
      inputSchema: { type: "object", properties: { cypher: { type: "string", description: "A read-only Cypher query." } }, required: ["cypher"] },
      annotations: hints,
      execute: reply(({ cypher }) => {
        if (typeof cypher !== "string") throw new Error("Give cypher as a string.");
        const writes = page.operators(cypher).flatMap((o) => o.match(/\w+/g) ?? []).filter((o) => !READS.has(o));
        if (writes.length)
          throw new Error(`Only reads run here, and this query plans ${[...new Set(writes)].join(", ")}. Use MATCH, OPTIONAL MATCH, WITH, UNWIND, UNION and RETURN.`);
        const r = page.query(cypher);
        if (r instanceof Error) throw r;
        return { columns: r.columns, rows: r.rows.slice(0, LIMIT), truncated: r.rows.length > LIMIT };
      }),
    },
    {
      name: "show_question",
      description:
        "Select a question in the Witness graph, highlight its upstream artifact dependencies, and show its evidence. Returns its text, rule, answer now, the goals it explores or accepts, dependencies and consumers, measurements of its current run, archived inputs, saved files, and runs. File URLs refer to the bytes that run read or saved. Exploratory questions never determine goal completion.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "The question's id: q- and 12 hex digits." } }, required: ["id"] },
      annotations: hints,
      execute: reply(({ id }) => {
        if (typeof id !== "string") throw new Error("Give a question id.");
        const d = page.question(id);
        if (!d) throw new Error(`There is no question ${id}. Call query to list the questions.`);
        const { status, read, saved, ...rest } = d;
        const urls = (files: { name: string; url: string }[]) => files.map((f) => ({ name: f.name, url: new URL(f.url, location.href).href }));
        return {
          ...rest,
          answer: status?.state ?? "waiting",
          was: status?.was ?? null,
          reason: status?.reason ?? null,
          read: urls(read),
          saved: urls(saved),
        };
      }),
    },
  ];
}

/** Gives the tools to the browser's agent, when the browser has WebMCP. Other browsers see nothing. */
export function register(tools: Tool[]) {
  const context = (document as { modelContext?: ModelContext }).modelContext ?? (navigator as { modelContext?: ModelContext }).modelContext;
  for (const tool of context ? tools : [])
    Promise.resolve(context!.registerTool(tool)).catch((e) => console.warn(`witness: the browser did not take the ${tool.name} tool:`, e));
}
type ModelContext = { registerTool(tool: Tool): unknown };
