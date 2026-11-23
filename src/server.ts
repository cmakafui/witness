// One Bun.serve for everything: the web page, MCP for agents, the files runs saved, and the live feed.
import { existsSync } from "node:fs";
import page from "../page/index.html";
import type { Hub } from "./hub.ts";
import { mcp } from "./mcp.ts";

/** The last time anyone used the server, and how many pages watch it now. The hub exits when nobody uses it. */
export type Activity = { last: number; pages: number };

export function serve(hub: Hub, { port = 4747, hostname = "127.0.0.1" } = {}) {
  const handle = mcp(hub);
  const activity: Activity = { last: Date.now(), pages: 0 };
  const used = () => (activity.last = Date.now());
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255, // the most Bun allows: ask waits for its answer, up to wait_s (at most 240 s)
    routes: {
      "/": page,
      "/mcp": (req, srv): Promise<Response> | Response => {
        used();
        return sameOrigin(req, srv.url) ? handle(req) : new Response("Forbidden: this request did not come from this machine's hub address.", { status: 403 });
      },
      "/files/:id": (req) => {
        used();
        const id = req.params.id;
        const path = hub.filePath(id);
        if (!path || !existsSync(path)) return new Response("Not found", { status: 404 });
        const name = new URL(req.url).searchParams.get("name") ?? id;
        return new Response(Bun.file(path), { headers: { "Content-Type": Bun.file(name).type, "X-Content-Type-Options": "nosniff" } });
      },
      "/cancel/:id": (req, srv) => {
        used();
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
        if (!sameOrigin(req, srv.url)) return new Response("Forbidden: this request did not come from this machine's hub address.", { status: 403 });
        try {
          return Response.json({ id: req.params.id, cancelled: hub.cancel(req.params.id) });
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 404 });
        }
      },
      "/health": () => (used(), Response.json({ root: hub.root, pid: process.pid })),
      "/events": (req, srv) => (srv.upgrade(req) ? undefined : new Response("Expected a WebSocket", { status: 400 })),
    },
    websocket: {
      open(ws) {
        activity.pages++;
        used();
        ws.subscribe("feed");
        ws.send(JSON.stringify({ type: "graph", ...hub.snapshot() }));
        ws.send(JSON.stringify({ type: "states", states: hub.statuses() }));
      },
      close() {
        activity.pages--;
        used();
      },
      message() {},
    },
  });
  hub.on((e) => server.publish("feed", JSON.stringify(e)));
  return Object.assign(server, { activity });
}

/**
 * Refuses MCP requests that a web page on another site sent through the browser (DNS rebinding): the Host must be the
 * hub's own, and an Origin, when there is one, too.
 */
export function sameOrigin(req: Request, url: URL): boolean {
  const host = req.headers.get("host");
  if (host && host !== url.host && host !== `localhost:${url.port}`) return false;
  const origin = req.headers.get("origin");
  return !origin || origin === url.origin || origin === `http://localhost:${url.port}`;
}
