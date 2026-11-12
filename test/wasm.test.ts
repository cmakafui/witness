// The web page can hold a Relate graph: Bun bundles the WASM build, and a real browser engine runs it.
import { expect, test } from "bun:test";
import page from "./wasm/page.html";

test("Relate's WASM build runs in a page that Bun bundles", async () => {
  const server = Bun.serve({ port: 0, routes: { "/": page } });
  try {
    await using view = new Bun.WebView({ width: 400, height: 200 });
    await view.navigate(server.url.href);
    let text = "";
    for (let i = 0; i < 100 && !/^(OK|FAIL)/.test(text); i++) {
      await Bun.sleep(100);
      text = await view.evaluate("document.getElementById('out').textContent");
    }
    expect(text).toBe(`OK ${JSON.stringify([{ a: "q-1", b: "q-0" }])}`);
  } finally {
    server.stop(true);
  }
}, 30_000);
