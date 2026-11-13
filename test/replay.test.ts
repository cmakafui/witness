// A recorded session plays back from the store alone: in order, each question pending until its run, ending as answered.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { replay, timeline } from "../src/replay.ts";

let root: string;
const ids: Record<string, string> = {};
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "witness-replay-"));
  writeFileSync(join(root, "data.txt"), "4 5 6");
  const hub = await Hub.open(root, { pollMs: 0 });
  const head = "# /// script\n# dependencies = []\n# ///\nimport json, os\n";
  const a = await hub.ask({
    text: "Does data.txt hold numbers?",
    rule: "$count >= 1",
    inputs: ["data.txt"],
    probe: `${head}n=[int(x) for x in open("data.txt").read().split()]\nassert n\njson.dump(n, open(os.path.join(os.environ["WITNESS_OUT"], "n.json"), "w"))\nprint("WITNESS_RESULT", json.dumps({"count": len(n)}))`,
  });
  const b = await hub.ask({
    text: "Is the total above 100?",
    rule: "$total > 100",
    inputs: [`${a.id}/n.json`],
    disputes: [a.id],
    probe: `${head}n=json.load(open("${a.id}/n.json"))\njson.dump(n, open(os.path.join(os.environ["WITNESS_OUT"], "n.json"), "w"))\nprint("WITNESS_RESULT", json.dumps({"total": sum(n)}))`,
  });
  const c = await hub.ask({ text: "Does it crash?", rule: "$x = 1", probe: `${head}raise SystemExit(2)\nprint("WITNESS_RESULT", "{}")` });
  const d = await hub.ask({ text: "Is the saved total above 100?", rule: "$total > 100", inputs: [`${b.id}/n.json`], probe: `${head}n=json.load(open("${b.id}/n.json"))\nprint("WITNESS_RESULT", json.dumps({"total": sum(n)}))` });
  Object.assign(ids, { a: a.id, b: b.id, c: c.id, d: d.id });
  await hub.idle();
  hub.close();
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the timeline brings every record after what it points to, and each question before its answer", () => {
  const steps = timeline(root);
  const seen = new Set<string>();
  let pending = false;
  for (const s of steps) {
    for (const n of s.nodes) seen.add(n.id);
    for (const r of s.rels) expect(seen.has(r.from) && seen.has(r.to)).toBe(true);
    if (s.states.some((x) => x.id === ids.a && x.state === "pending")) pending = true;
  }
  expect(pending).toBe(true);
  const last = Object.fromEntries(steps.at(-1)!.states.map((s) => [s.id, s.state]));
  expect(last).toEqual({ [ids.a!]: "yes", [ids.b!]: "no", [ids.c!]: "failed", [ids.d!]: "no" });
});

test("the page plays the session back into its own Relate copy", async () => {
  const server = replay(root, { port: 0, stepMs: 20 });
  try {
    await using view = new Bun.WebView({ width: 1000, height: 700 });
    await view.navigate(server.url.href);
    let got = "";
    for (let i = 0; i < 100 && got !== "no"; i++) {
      await Bun.sleep(100);
      got = (await view.evaluate(`window.witness ? window.witness.state(${JSON.stringify(ids.b)}) : null`).catch(() => null)) as string;
    }
    expect(got).toBe("no");
    const disputes = await view.evaluate(`window.witness.cypher("MATCH (:Question)-[:DISPUTES]->(q:Question) RETURN q.id AS id")`);
    expect(disputes).toEqual([{ id: ids.a }]);

    // The page's WebMCP tools: they read the page's copy, show the person what they found, and refuse to write.
    // A refusal is a reply the agent can read and fix, as on /mcp.
    const call = (name: string, args: object) =>
      view.evaluate(`window.witness.tools.find((t) => t.name === ${JSON.stringify(name)}).execute(${JSON.stringify(args)}).then(JSON.parse)`);
    expect(await view.evaluate("window.witness.tools.map((t) => [t.name, t.annotations.readOnlyHint, t.annotations.untrustedContentHint])")).toEqual([
      ["query", true, true],
      ["show_question", true, true],
      ["navigate", true, true],
    ]);
    const yes = "MATCH (q:Question) WHERE q.id IN $yes RETURN q.id AS id";
    expect(await call("query", { cypher: yes })).toEqual({ columns: ["id"], rows: [{ id: ids.a }], truncated: false });
    expect(await view.evaluate("[document.getElementById('cypher').value, document.getElementById('query').hidden]")).toEqual([yes, false]);

    for (const cypher of ["MATCH (q:Question) SET q.text = 'forged'", "CREATE (:Question {id: 'q-000000000000'})", "MATCH (q) CALL { CREATE (:Run) } RETURN q"])
      expect(((await call("query", { cypher })) as { refused: string }).refused).toStartWith("Only reads run here");
    const forged = "MATCH (n) WHERE n.text = 'forged' OR n.id = 'q-000000000000' OR (n:Run AND n.id IS NULL) RETURN count(n) AS n";
    expect(await view.evaluate(`window.witness.cypher(${JSON.stringify(forged)})`)).toEqual([{ n: 0 }]);

    const shown = (await call("show_question", { id: ids.b })) as Record<string, unknown>;
    expect(shown).toMatchObject({ id: ids.b, answer: "no", restsOn: [ids.a], disputes: [ids.a] });
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the total above 100?");
    expect(await call("show_question", { id: "q-ffffffffffff" })).toEqual({ refused: `There is no question q-ffffffffffff. Call query to list the questions.` });

    const neighborhood = (relation: string, id?: string, depth?: number) => call("navigate", { relation, ...(id ? { id } : {}), ...(depth === undefined ? {} : { depth }) });
    // Observe the actual Motion sequence: the panel stays closed until the camera and paths finish.
    await view.evaluate(`(() => { window.walkStages = []; new MutationObserver(() => {
      window.walkStages.push([document.querySelector('main').dataset.walkthroughStage, document.getElementById('sidebar-toggle').getAttribute('aria-expanded')]);
    }).observe(document.querySelector('main'), {attributes: true, attributeFilter: ['data-walkthrough-stage']}); })()`);
    const dependencies = await neighborhood("dependencies", ids.b, 2) as { questions: { id: string; text: string; answer: string }[]; links: object[] };
    expect(await view.evaluate("window.walkStages")).toEqual([["camera", "false"], ["paths", "false"], ["evidence", "true"], ["complete", "true"]]);
    expect(await view.evaluate("document.querySelector('main').classList.contains('walking')")).toBe(false);
    expect(dependencies.questions).toEqual([{ id: ids.b!, text: "Is the total above 100?", answer: "no" }, { id: ids.a!, text: "Does data.txt hold numbers?", answer: "yes" }]);
    expect(dependencies.links).toEqual([{ from: ids.b, to: ids.a, type: "NEEDS" }]);
    expect(await view.evaluate("document.getElementById('navigation-summary').textContent")).toBe("Dependencies · 2 questions · 1 link · depth 2");
    expect(await view.evaluate("document.getElementById('question').hidden")).toBe(false);

    // An interrupt resolves the old tool call, and cannot reopen a stale panel later.
    expect(await view.evaluate(`(async () => {
      const navigate = window.witness.tools.find(t => t.name === 'navigate');
      const first = navigate.execute({relation:'dependencies', id:${JSON.stringify(ids.a)}});
      await navigate.execute({relation:'overview'});
      return JSON.parse(await first);
    })()`)).toEqual({ id: ids.a, cancelled: true });
    expect(await view.evaluate("document.getElementById('sidebar-toggle').getAttribute('aria-expanded')")).toBe("false");

    // Pause freezes the active Motion stage, then resumes that same question.
    await view.evaluate("document.getElementById('tour-play').click()");
    await Bun.sleep(100);
    await view.evaluate("document.getElementById('tour-play').click()");
    expect(await view.evaluate("document.getElementById('tour-progress').textContent")).toBe("Paused · 1 / 4");
    await Bun.sleep(1200);
    expect(await view.evaluate("document.querySelector('main').dataset.walkthroughStage")).toBe("camera");
    await view.evaluate("document.getElementById('tour-play').click()");
    for (let i = 0; i < 50; i++) {
      if (await view.evaluate("document.querySelector('main').dataset.walkthroughStage === 'complete'")) break;
      await Bun.sleep(100);
    }
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does data.txt hold numbers?");
    await view.evaluate("document.getElementById('tour-play').click()");

    // Exercise the same traversal with reduced motion: no tween or delayed evidence reveal.
    await view.evaluate(`(() => { window.originalMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const media = window.originalMatchMedia(query);
        if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(media, 'matches', {value:true});
        return media;
      }; })()`);
    expect(await neighborhood("dependencies", ids.d, 1)).toMatchObject({ questions: [{ id: ids.d }, { id: ids.b }] });
    expect(await neighborhood("dependencies", ids.d, 2)).toMatchObject({ questions: [{ id: ids.d }, { id: ids.b }, { id: ids.a }] });
    // A missing id uses the current selection. Reverse traversal reaches the consumer.
    expect(await neighborhood("dependents", ids.a)).toMatchObject({ questions: [{ id: ids.a }, { id: ids.b }] });
    expect(await neighborhood("dependents", ids.a, 2)).toMatchObject({ questions: [{ id: ids.a }, { id: ids.b }, { id: ids.d }] });
    expect(await neighborhood("dependencies")).toMatchObject({ id: ids.a, questions: [{ id: ids.a }], links: [] });
    for (const start of [ids.a, ids.b]) expect(await neighborhood("disputes", start)).toMatchObject({ links: [{ from: ids.b, to: ids.a, type: "DISPUTES" }] });
    expect(await neighborhood("dependencies", ids.c)).toMatchObject({ questions: [{ id: ids.c, answer: "failed" }], links: [] });
    expect(await neighborhood("dependencies", "q-ffffffffffff")).toHaveProperty("refused");
    for (const depth of [0, 1.5, 11]) expect(await neighborhood("dependencies", ids.a, depth)).toHaveProperty("refused");
    expect(await neighborhood("invented", ids.a)).toHaveProperty("refused");
    expect(await neighborhood("overview")).toMatchObject({ relation: "overview", questions: 4 });
    expect(await view.evaluate("document.getElementById('navigation').hidden")).toBe(true);

    // Previous/next work while paused, and autoplay visits all questions (including the failure) in order.
    await view.evaluate("document.getElementById('tour-next').click()");
    await Bun.sleep(50);
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the total above 100?");
    expect(await view.evaluate("document.getElementById('tour-progress').textContent")).toBe("Paused · 2 / 4");
    await view.evaluate("document.getElementById('tour-previous').click()");
    await Bun.sleep(50);
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does data.txt hold numbers?");
    expect(await view.evaluate("document.getElementById('tour-previous').disabled")).toBe(true);
    await view.evaluate(`(() => {
      const seek = document.getElementById('tour-seek');
      seek.value = '2'; seek.dispatchEvent(new Event('input'));
    })()`);
    expect(await view.evaluate("document.getElementById('tour-progress').textContent")).toBe("Seek · 3 / 4");
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does data.txt hold numbers?");
    await view.evaluate("document.getElementById('tour-seek').dispatchEvent(new Event('change'))");
    await Bun.sleep(50);
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Does it crash?");
    expect(await view.evaluate("document.querySelector('#question .badge').textContent")).toBe("failed");
    await view.evaluate(`(() => {
      const seek = document.getElementById('tour-seek');
      seek.value = '0'; seek.dispatchEvent(new Event('input')); seek.dispatchEvent(new Event('change'));
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 2500 ? 20 : ms, ...args);
    })()`);
    await Bun.sleep(50);
    await view.evaluate("document.getElementById('tour-play').click()");
    await Bun.sleep(100);
    expect(await view.evaluate("document.getElementById('tour').classList.contains('auto-hidden')")).toBe(true);
    expect(await view.evaluate("document.getElementById('tour-peek').hidden")).toBe(false);
    await view.evaluate("document.getElementById('tour-peek').click()");
    expect(await view.evaluate("document.getElementById('tour').classList.contains('auto-hidden')")).toBe(false);
    await view.evaluate("document.getElementById('tour-play').click()");
    await view.evaluate(`(() => {
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => timeout(fn, ms >= 4900 && ms <= 5000 ? 30 : ms, ...args);
      window.tourStops = [];
      new MutationObserver(() => {
        const text = document.getElementById('tour-progress').textContent;
        if (!window.tourStops.includes(text)) window.tourStops.push(text);
      }).observe(document.getElementById('tour-progress'), {childList:true});
      document.getElementById('tour-play').click();
    })()`);
    for (let i = 0; i < 100; i++) {
      if (await view.evaluate("document.getElementById('tour-progress').textContent === 'Finished · 4 / 4'")) break;
      await Bun.sleep(50);
    }
    expect(await view.evaluate("document.getElementById('tour-progress').textContent")).toBe("Finished · 4 / 4");
    expect(await view.evaluate("window.tourStops.includes('Playing · 3 / 4')")).toBe(true);
    expect(await view.evaluate("document.querySelector('#question h2').textContent")).toBe("Is the saved total above 100?");
    expect(await view.evaluate("[document.getElementById('tour-next').disabled,document.getElementById('tour-play').textContent]")).toEqual([true, "Replay"]);
    await view.evaluate("document.getElementById('tour-play').click()");
    await view.evaluate("document.getElementById('tour-play').click()");
    expect(await view.evaluate("document.getElementById('tour-progress').textContent")).toBe("Paused · 1 / 4");
  } finally {
    server.stop(true);
  }
}, 30_000);
