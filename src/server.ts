// One Bun.serve for everything: the web page, MCP for agents, the files runs saved, the live feed, and Cancel.
import { existsSync } from "node:fs";
import { join } from "node:path";
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
      "/files/:id": (req) => (used(), fileResponse(req, hub.filesDir)),
      // The Cancel button on the page. No tool and no command can cancel.
      "/cancel/:id": {
        POST: (req, srv) => {
          used();
          if (!sameOrigin(req, srv.url)) return new Response("Forbidden: this request did not come from this machine's hub address.", { status: 403 });
          return Response.json({ id: req.params.id, cancelled: hub.cancel(req.params.id) });
        },
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

/** A kept file by its SHA-256, typed by the name the page gives it (?name=), for the hub and for replay. */
export function fileResponse(req: Request & { params: { id: string } }, filesDir: string): Response {
  const id = req.params.id;
  const path = join(filesDir, id);
  if (!/^[0-9a-f]{64}$/.test(id) || !existsSync(path)) return new Response("Not found", { status: 404 });
  const name = new URL(req.url).searchParams.get("name") ?? id;
  return new Response(Bun.file(path), { headers: { "Content-Type": Bun.file(name).type, "X-Content-Type-Options": "nosniff" } });
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
