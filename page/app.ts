/// <reference lib="dom" />
// The live page. It keeps its own copy of the graph in Relate (WASM), built by the same statements the hub runs,
// and answers every panel and query with Cypher in the page. The hub sends new records, states and results.
import init, { RelateDb } from "@relate/relate-wasm";
import wasmUrl from "@relate/relate-wasm/relate_bg.wasm" with { type: "file" };
import ForceGraph from "force-graph";
import { answerParams, type GNode, type GRel, type State, type Status, statements } from "../src/graph.ts";

type Msg =
  | { type: "graph"; nodes: GNode[]; rels: GRel[] }
  | { type: "states"; states: Status[] }
  | { type: "result"; question: string; run: string; data: unknown };

type QNode = { id: string; text: string; asker: string | null; x?: number; y?: number };
type QLink = { source: string | QNode; target: string | QNode; type: "NEEDS" | "DISPUTES" };
type Row = Record<string, unknown>;

await init({ module_or_path: wasmUrl });
const db = new RelateDb();

function cypher(query: string, params: Record<string, unknown> = {}): Row[] {
  const r = JSON.parse(db.execute(query, JSON.stringify(params)));
  if (r.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
  return r.rows;
}

// ---------------------------------------------------------------------------------------------------------------
// State

const nodes = new Map<string, QNode>();
const links: QLink[] = [];
let statuses = new Map<string, Status>();
const live = new Map<string, unknown[]>(); // run -> results printed so far
let selected: string | null = null;
let marked = new Set<string>();

const color = (s: State | undefined) => getComputedStyle(document.documentElement).getPropertyValue(`--${s === "pending" ? "running" : (s ?? "waiting")}`).trim();
const hollow = (s: State | undefined) => s === "pending" || s === "waiting" || s === undefined;

// ---------------------------------------------------------------------------------------------------------------
// The graph view

const el = document.getElementById("graph")!;
const graph = new ForceGraph<QNode, QLink>(el)
  .nodeId("id")
  .graphData({ nodes: [], links: [] })
  .autoPauseRedraw(false)
  .linkColor((l) => (l.type === "DISPUTES" ? color("no") : getComputedStyle(document.documentElement).getPropertyValue("--line")))
  .linkWidth((l) => (l.type === "DISPUTES" ? 1.5 : 1.2))
  .linkLineDash((l) => (l.type === "DISPUTES" ? [4, 3] : null))
  .linkDirectionalArrowLength(5)
  .linkDirectionalArrowRelPos(1)
  .nodeRelSize(7)
  .nodeLabel((n) => n.text)
  .onNodeClick((n) => select(n.id))
  .nodeCanvasObject((n, ctx, scale) => {
    const s = statuses.get(n.id)?.state;
    const r = 7;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    if (s === "running") {
      const t = (performance.now() % 1400) / 1400;
      ctx.beginPath();
      ctx.arc(x, y, r + 2 + t * 8, 0, 2 * Math.PI);
      ctx.strokeStyle = color("running");
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 2 / scale;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (hollow(s)) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--panel");
      ctx.fill();
      ctx.strokeStyle = color(s);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = color(s);
      ctx.fill();
    }
    if (n.id === selected || marked.has(n.id)) {
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
      ctx.lineWidth = n.id === selected ? 3 : 2;
      ctx.stroke();
    }
    if (scale > 0.9) {
      const label = n.text.length > 48 ? `${n.text.slice(0, 46)}…` : n.text;
      ctx.font = `${11 / Math.min(scale, 2)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted");
      ctx.fillText(label, x, y + r + 4);
    }
  });

graph.cooldownTime(2500);
graph.d3Force("charge")?.strength(-260).distanceMax(320);
graph.d3Force("link")?.distance(90);
// Fit the view once the layout settles after new questions arrive; leave the viewer's zoom alone otherwise.
let fitted = 0;
graph.onEngineStop(() => {
  if (nodes.size !== fitted) graph.zoomToFit(500, 160);
  fitted = nodes.size;
});
new ResizeObserver(() => graph.width(el.clientWidth).height(el.clientHeight)).observe(el);

function redraw() {
  graph.graphData({ nodes: [...nodes.values()], links: [...links] });
}

// ---------------------------------------------------------------------------------------------------------------
// Messages from the hub

function apply(m: Msg) {
  if (m.type === "graph") {
    for (const s of statements(m.nodes, m.rels)) cypher(s.cypher, s.params);
    let changed = false;
    for (const n of m.nodes)
      if (n.label === "Question" && !nodes.has(n.id)) {
        nodes.set(n.id, { id: n.id, text: String(n.props.text), asker: (n.props.asker as string) ?? null });
        changed = true;
      }
    for (const r of m.rels)
      if ((r.type === "NEEDS" || r.type === "DISPUTES") && !links.some((l) => id(l.source) === r.from && id(l.target) === r.to && l.type === r.type)) {
        links.push({ source: r.from, target: r.to, type: r.type });
        changed = true;
      }
    if (changed) redraw();
  } else if (m.type === "states") {
    statuses = new Map(m.states.map((s) => [s.id, s]));
    counts();
  } else if (m.type === "result") {
    live.set(m.run, [...(live.get(m.run) ?? []), m.data]);
  }
  if (selected && (m.type !== "result" || m.question === selected)) showQuestion(selected);
}

const id = (end: string | QNode) => (typeof end === "string" ? end : end.id);

function connect(delay = 500) {
  const link = document.getElementById("link")!;
  const ws = new WebSocket(new URL("/events", location.href.replace(/^http/, "ws")));
  ws.onopen = () => ((link.textContent = "live"), (link.className = "on"));
  ws.onmessage = (e) => apply(JSON.parse(e.data));
  ws.onclose = () => {
    link.textContent = "reconnecting";
    link.className = "off";
    setTimeout(() => connect(Math.min(delay * 2, 8000)), delay);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The panel

function h(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
}

function badge(s: Status | undefined) {
  const state = s?.state ?? "waiting";
  const b = h("span", { class: `badge${hollow(state) ? " hollow" : ""}`, style: `--c: var(--${state === "pending" ? "running" : state})` }, state);
  return s?.was ? h("span", {}, b, h("span", { class: "hint" }, ` was ${s.was}`)) : b;
}

function ref(q: string) {
  const a = h("span", { class: "ref id" }, q);
  a.onclick = () => select(q);
  return a;
}

function fileLink(name: string, file: string) {
  const url = `/files/${file}?name=${encodeURIComponent(name)}`;
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(name)) return h("div", {}, h("a", { href: url, target: "_blank" }, name), h("img", { class: "out", src: url, alt: name }));
  return h("a", { href: url, target: "_blank" }, name);
}

function counts() {
  const all = [...statuses.values()];
  const box = document.getElementById("counts")!;
  box.replaceChildren(
    ...(["yes", "no", "failed", "running", "pending", "waiting"] as State[])
      .map((s) => [s, all.filter((x) => x.state === s).length] as const)
      .filter(([, n]) => n)
      .map(([s, n]) => h("span", { style: `--c: var(--${s === "pending" ? "running" : s})` }, `${n} ${s}`)),
  );
}

function showQuestion(qid: string) {
  const box = document.getElementById("question")!;
  const [q] = cypher("MATCH (q:Question {id: $id}) RETURN q.text AS text, q.rule AS rule, q.inputs AS inputs, q.asker AS asker", { id: qid });
  if (!q) return;
  const s = statuses.get(qid);
  const [l] = cypher(
    `MATCH (q:Question {id: $id})
     OPTIONAL MATCH (q)-[:NEEDS]->(n:Question) WITH q, collect(DISTINCT n.id) AS needs
     OPTIONAL MATCH (m:Question)-[:NEEDS]->(q) WITH q, needs, collect(DISTINCT m.id) AS neededBy
     OPTIONAL MATCH (q)-[:DISPUTES]->(d:Question) WITH q, needs, neededBy, collect(DISTINCT d.id) AS disputes
     OPTIONAL MATCH (e:Question)-[:DISPUTES]->(q)
     RETURN needs, neededBy, disputes, collect(DISTINCT e.id) AS disputedBy`,
    { id: qid },
  );
  const runs = cypher(
    `MATCH (r:Run)-[:ANSWERS]->(:Question {id: $id}) OPTIONAL MATCH (a:Answer)-[:OF]->(r)
     RETURN r.id AS run, r.seq AS seq, a.value AS value, a.reason AS reason, a.results AS results ORDER BY r.seq DESC`,
    { id: qid },
  );
  const current = s?.run ?? null;
  const shown = runs.find((r) => r.run === current) ?? runs[0];
  const results = shown ? (shown.value ? JSON.parse(String(shown.results)) : (live.get(String(shown.run)) ?? [])) : [];
  const saved = shown ? cypher("MATCH (:Run {id: $run})-[s:SAVED]->(f:File) RETURN s.name AS name, f.id AS file ORDER BY name", { run: shown.run }) : [];
  const packages = shown ? cypher("MATCH (:Run {id: $run})-[:USED]->(p:Package) RETURN p.id AS id ORDER BY id", { run: shown.run }) : [];
  const list = (title: string, ids: unknown) =>
    Array.isArray(ids) && ids.length ? [h("h3", {}, title), h("ul", {}, ...ids.map((x) => h("li", {}, ref(String(x)))))] : [];

  const parts: (HTMLElement | null)[] = [
    h("div", { class: "run" }, badge(s), h("span", { class: "id hint" }, qid), q.asker ? h("span", { class: "hint" }, `asked by ${q.asker}`) : null),
    h("h2", {}, String(q.text)),
    h("p", { class: "rule" }, `Rule: ${q.rule}`),
    s?.reason ? h("p", { class: "error" }, s.reason) : null,
    ...(Array.isArray(q.inputs) && q.inputs.length ? [h("h3", {}, "Inputs"), h("ul", {}, ...q.inputs.map((i) => h("li", { class: "id" }, String(i))))] : []),
    ...list("Rests on", l?.needs),
    ...list("Used by", l?.neededBy),
    ...list("Disputes", l?.disputes),
    ...list("Disputed by", l?.disputedBy),
    results.length ? h("h3", {}, shown?.value ? "Results" : "Results so far") : null,
    results.length ? h("pre", {}, results.map((x: unknown) => JSON.stringify(x)).join("\n")) : null,
    saved.length ? h("h3", {}, "Saved") : null,
    saved.length ? h("ul", {}, ...saved.map((f) => h("li", {}, fileLink(String(f.name), String(f.file))))) : null,
    packages.length ? h("h3", {}, "Packages") : null,
    packages.length ? h("p", { class: "id hint" }, packages.map((p) => p.id).join("  ")) : null,
    runs.length ? h("h3", {}, "Runs") : null,
    h(
      "ul",
      {},
      ...runs.map((r) =>
        h(
          "li",
          { class: "run" },
          h("span", { class: "id hint" }, `#${r.seq}`),
          r.value ? h("span", { class: "badge", style: `--c: var(--${r.value})` }, String(r.value)) : h("span", { class: "hint" }, "running"),
          r.run === current ? h("span", { class: "hint" }, "current") : null,
          r.reason ? h("span", { class: "reason" }, String(r.reason).split("\n")[0]!) : null,
        ),
      ),
    ),
  ];
  box.replaceChildren(...parts.filter((x) => x !== null));
}

function select(qid: string) {
  selected = qid;
  tab("question");
  showQuestion(qid);
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

const PRESETS: [string, string][] = [
  ["Yes answers that nothing disputes", "MATCH (q:Question)\nWHERE q.id IN $yes AND NOT EXISTS { (:Question)-[:DISPUTES]->(q) }\nRETURN q.id AS id, q.text AS text ORDER BY q.seq"],
  ["Questions that build on the same output", "MATCH (a:Question)-[:NEEDS]->(u:Question)<-[:NEEDS]-(b:Question)\nWHERE a.seq < b.seq\nRETURN u.id AS output_of, a.id AS a, b.id AS b"],
  ["Packages, by first use", "MATCH (r:Run)-[:USED]->(p:Package)\nWITH p, min(r.seq) AS first, count(DISTINCT r) AS runs\nRETURN p.name AS package, p.version AS version, first, runs ORDER BY first"],
  ["What the selected question rests on", "MATCH (q:Question {id: $selected})-[:NEEDS*0..]->(u:Question)\nRETURN DISTINCT u.id AS id, u.text AS text, u.seq AS seq ORDER BY seq"],
  ["Failed runs, and why", "MATCH (a:Answer {value: 'failed'})-[:OF]->(r:Run)-[:ANSWERS]->(q:Question)\nRETURN q.id AS id, a.reason AS reason, r.seq AS seq ORDER BY seq DESC"],
];

const preset = document.getElementById("preset") as HTMLSelectElement;
const text = document.getElementById("cypher") as HTMLTextAreaElement;
preset.replaceChildren(...PRESETS.map(([name], i) => h("option", { value: String(i) }, name)));
preset.onchange = () => (text.value = PRESETS[Number(preset.value)]![1]);
text.value = PRESETS[0]![1];

document.getElementById("run")!.onclick = () => {
  const out = document.getElementById("rows")!;
  try {
    const rows = cypher(text.value, { ...answerParams([...statuses.values()]), selected });
    marked = new Set(rows.flatMap((r) => Object.values(r).filter((v): v is string => typeof v === "string" && nodes.has(v))));
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    const cell = (v: unknown) => (typeof v === "string" && nodes.has(v) ? ref(v) : typeof v === "string" ? v : JSON.stringify(v));
    out.replaceChildren(
      rows.length
        ? h("table", {}, h("tr", {}, ...cols.map((c) => h("th", {}, c))), ...rows.map((r) => h("tr", {}, ...cols.map((c) => h("td", {}, cell(r[c]))))))
        : h("p", { class: "hint" }, "No rows."),
    );
  } catch (e) {
    marked = new Set();
    out.replaceChildren(h("p", { class: "error" }, (e as Error).message));
  }
};

function tab(name: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const s of document.querySelectorAll<HTMLElement>("aside section")) s.hidden = s.id !== name;
}
for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) b.onclick = () => tab(b.dataset.tab!);

connect();

// For tests and the browser console: read the page's copy of the graph.
Object.assign(window, { witness: { cypher, select, state: (q: string) => statuses.get(q)?.state ?? null, questions: () => nodes.size } });
