// One Bun.serve for everything: the web page, MCP for agents, the files runs saved, and the live feed.
import { existsSync } from "node:fs";
import page from "../page/index.html";
import type { Hub } from "./hub.ts";
import { mcp } from "./mcp.ts";

export function serve(hub: Hub, { port = 4747, hostname = "127.0.0.1" } = {}) {
  const handle = mcp(hub);
  const server = Bun.serve({
    port,
    hostname,
    routes: {
      "/": page,
      "/mcp": (req, srv): Promise<Response> | Response =>
        sameOrigin(req, srv.url) ? handle(req) : new Response("Forbidden: this request did not come from this machine's hub address.", { status: 403 }),
      "/files/:id": (req) => {
        const id = req.params.id;
        const path = hub.filePath(id);
        if (!path || !existsSync(path)) return new Response("Not found", { status: 404 });
        const name = new URL(req.url).searchParams.get("name") ?? id;
        return new Response(Bun.file(path), { headers: { "Content-Type": Bun.file(name).type, "X-Content-Type-Options": "nosniff" } });
      },
      "/events": (req, srv) => (srv.upgrade(req) ? undefined : new Response("Expected a WebSocket", { status: 400 })),
    },
    websocket: {
      open(ws) {
        ws.subscribe("feed");
        ws.send(JSON.stringify({ type: "graph", ...hub.snapshot() }));
        ws.send(JSON.stringify({ type: "states", states: hub.statuses() }));
      },
      message() {},
    },
  });
  hub.on((e) => server.publish("feed", JSON.stringify(e)));
  return server;
}

/**
 * Refuses MCP requests that a web page on another site sent through the browser (DNS rebinding): the Host must be the
 * hub's own, and an Origin, when there is one, too.
 */
function sameOrigin(req: Request, url: URL): boolean {
  const host = req.headers.get("host");
  if (host && host !== url.host && host !== `localhost:${url.port}`) return false;
  const origin = req.headers.get("origin");
  return !origin || origin === url.origin || origin === `http://localhost:${url.port}`;
}
