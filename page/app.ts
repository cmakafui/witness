/// <reference lib="dom" />
// The live page. It keeps its own copy of the graph in Relate (WASM), built by the same statements the hub runs,
// and answers every panel and query with Cypher in the page. The hub sends new records and states.
//
// The lanes show how the agents got here: one row per direction of work, compact glyphs packed left-to-right by
// causal and lane order, with a steady top preview strip on hover. The rule check on the right shows why an answer
// stands: each part of the rule, the measurements it names, and whether it held. DESIGN.md gives the tokens.
import init, { RelateDb } from "@relate/relate-wasm";
import wasmUrl from "@relate/relate-wasm/relate_bg.wasm" with { type: "file" };
import { answerParams, clauses, type Goal, GOALS, type GNode, type GRel, measurements, named, type State, type Status, statements } from "../src/graph.ts";
import { register, webTools } from "./tools.ts";

type Msg =
  | { type: "graph"; nodes: GNode[]; rels: GRel[] }
  | { type: "states"; states: Status[] };

type QNode = { id: string; text: string; asker: string | null; seq: number; inputs: string[] };
type QLink = { source: string; target: string };
type Row = Record<string, unknown>;

await init({ module_or_path: wasmUrl });
const db = new RelateDb();

/** Runs one statement on the page's copy and returns Relate's envelope. An engine error throws. */
function execute(query: string, params: Record<string, unknown> = {}) {
  const r = JSON.parse(db.execute(query, JSON.stringify(params)));
  if (r.error) throw new Error(typeof r.error === "string" ? r.error : (r.error.message ?? JSON.stringify(r.error)));
  return r as { columns: string[]; rows: Row[]; plan: Plan | null };
}
type Plan = { root: { operator: string; children: Plan["root"][] } };

/** Runs Cypher on the page's copy. The columns come in the order the query returns them. */
function result(query: string, params: Record<string, unknown> = {}): { columns: string[]; rows: Row[] } {
  const { columns, rows } = execute(query, params);
  return { columns, rows };
}
const cypher = (query: string, params: Record<string, unknown> = {}) => result(query, params).rows;

// ---------------------------------------------------------------------------------------------------------------
// State

const nodes = new Map<string, QNode>();
const links: QLink[] = [];
let statuses = new Map<string, Status>();
let selected: string | null = null;
let hovered: string | null = null;
let selectedGoal = "";
let goalInitialized = false;
let marked = new Set<string>();
type Neighborhood = { nodes: Set<string>; links: Set<string> };
type QuestionVisit = { id: string; scroll: number; lanes: number; probeOpen: boolean; runsOpen: boolean; marked: Set<string> };
const questionHistory: QuestionVisit[] = [];
const linkId = (l: QLink) => `${l.source}:${l.target}`;
const stateOf = (q: string): State => statuses.get(q)?.state ?? "waiting";
const colour = (s: State) => `var(--${s === "pending" ? "running" : s})`;
const goals = () => cypher(GOALS) as Goal[];

/** All upstream artifact dependencies, including shared inputs from other goals. */
function upstream(roots: string[]): Neighborhood {
  const found = new Set(roots), followed = new Set<string>();
  let frontier = roots;
  while (frontier.length) {
    const next: string[] = [];
    for (const l of links) if (frontier.includes(l.source)) {
      followed.add(linkId(l));
      if (!found.has(l.target)) { found.add(l.target); next.push(l.target); }
    }
    frontier = next;
  }
  return { nodes: found, links: followed };
}

// ---------------------------------------------------------------------------------------------------------------
// Elements

function h(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
}

const SVG = "http://www.w3.org/2000/svg";
function s(tag: string, attrs: Record<string, string | number> = {}, ...kids: (Node | null | false)[]): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** A question's glyph: filled for an answer, hollow without one, a slashed ring for failed. */
function glyph(state: State, r: number): SVGElement {
  const g = s("g", { style: `--c: ${colour(state)}` });
  const answered = state === "yes" || state === "no";
  g.append(s("circle", { r, class: `glyph ${state}${answered ? "" : " hollow"}` }));
  if (state === "failed") g.append(s("line", { class: "slash", x1: -r * 0.62, y1: r * 0.62, x2: r * 0.62, y2: -r * 0.62 }));
  return g;
}

/** A glyph on its own, for the hover bar, chips and refs. */
function mark(state: State, size = 12, accepts = false) {
  const half = size / 2;
  if (accepts) {
    return s(
      "svg",
      { width: size + 4, height: size + 4, viewBox: `${-(half + 2)} ${-(half + 2)} ${size + 4} ${size + 4}`, "aria-hidden": "true" },
      s("circle", { r: half + 0.5, class: "accept-ring", style: `--c: ${colour(state)}` }),
      glyph(state, Math.max(2.5, half - 2.5)),
    );
  }
  return s("svg", { width: size, height: size, viewBox: `${-half} ${-half} ${size} ${size}`, "aria-hidden": "true" }, glyph(state, half - 1.5));
}

// ---------------------------------------------------------------------------------------------------------------
// Hover bar & lanes

const main = document.querySelector("main")!;
const hoverBar = document.getElementById("hover-bar")!;
const el = document.getElementById("graph")!;
const sidebar = document.getElementById("sidebar")!;
const sidebarToggle = document.getElementById("sidebar-toggle")!;
const evidenceBack = document.getElementById("evidence-back") as HTMLButtonElement;
const names = h("div", { class: "lane-names", "aria-hidden": "true" });
const scroller = h("div", { class: "lanes" });
const svg = s("svg", { role: "group", "aria-label": "Questions by direction of work" }) as SVGSVGElement;
scroller.append(svg);
const empty = h("p", { class: "empty" }, "No questions yet.");

const TOP = 20;
const PAD = 40;
const STEP = 68;
/** Where each question sits, from the last render. */
const place = new Map<string, { x: number; y: number; lane: number }>();

/** The lane of an asker: the part after the last /, before the first -. orchestrator/evolution and evolution-tools share one. */
const laneOf = (asker: string | null) => {
  const last = (asker ?? "").split("/").at(-1)!.trim();
  return (last.split("-")[0] || last || "unnamed").replaceAll("_", " ");
};

function renderHover() {
  const activeId = hovered && nodes.has(hovered) ? hovered : selected && nodes.has(selected) ? selected : null;
  if (!activeId) {
    hoverBar.replaceChildren(nodes.size ? h("span", { class: "hint" }, "All questions") : "");
    return;
  }
  const q = nodes.get(activeId)!;
  const st = stateOf(activeId);
  const accepts = goals().some((g) => g.acceptance === activeId);
  hoverBar.replaceChildren(
    mark(st, 12, accepts),
    h("span", { class: "hover-state", style: `--c: ${colour(st)}` }, st),
    h("span", { class: "hover-text" }, q.text),
    h("span", { class: "hover-lane" }, laneOf(q.asker)),
  );
}

/** Updates hover state without rebuilding the lane SVG, so clicks and frame observers stay clean. */
function setHovered(id: string | null) {
  if (hovered === id) return;
  if (hovered) svg.querySelector(`[data-id="${hovered}"] .hover-ring`)?.setAttribute("opacity", "0");
  hovered = id;
  if (hovered && hovered !== selected) svg.querySelector(`[data-id="${hovered}"] .hover-ring`)?.setAttribute("opacity", "1");
  renderHover();
}
svg.addEventListener("pointerleave", () => setHovered(null));

function focusNeighbor(fromId: string, key: string) {
  const cur = place.get(fromId);
  if (!cur) return;
  const candidates = [...place.entries()].filter(([id]) => id !== fromId);
  let target: string | undefined;
  if (key === "ArrowRight" || key === "ArrowLeft") {
    const dir = key === "ArrowRight" ? 1 : -1;
    const sameLane = candidates
      .filter(([, p]) => p.lane === cur.lane && (p.x - cur.x) * dir > 0)
      .sort((a, b) => Math.abs(a[1].x - cur.x) - Math.abs(b[1].x - cur.x));
    target = sameLane[0]?.[0];
  } else if (key === "ArrowDown" || key === "ArrowUp") {
    const nextLane = cur.lane + (key === "ArrowDown" ? 1 : -1);
    const adj = candidates
      .filter(([, p]) => p.lane === nextLane)
      .sort((a, b) => Math.abs(a[1].x - cur.x) - Math.abs(b[1].x - cur.x));
    target = adj[0]?.[0];
  }
  if (target) (svg.querySelector(`[data-id="${target}"]`) as HTMLElement | null)?.focus();
}

function render() {
  const questions = [...nodes.values()].sort((a, b) => a.seq - b.seq);
  renderHover();
  if (!questions.length) {
    el.replaceChildren(empty);
    return;
  }
  if (!scroller.isConnected) el.replaceChildren(names, scroller);
  const lanes = [...new Set(questions.map((q) => laneOf(q.asker)))];
  const lane = Math.round(Math.max(48, Math.min(72, (el.clientHeight - TOP - 20) / lanes.length)));
  el.style.setProperty("--lane", `${lane}px`);
  const height = TOP + lane * lanes.length + 20;

  // Pack parallel work into shared columns while keeping each lane chronological and every dependency left-to-right.
  place.clear();
  const colOf = new Map<string, number>();
  const laneEnd = new Map<string, number>();
  let maxCol = 0;
  for (const q of questions) {
    const name = laneOf(q.asker);
    const laneIdx = lanes.indexOf(name);
    const deps = links.filter((l) => l.source === q.id).map((l) => (colOf.get(l.target) ?? -1) + 1);
    const col = Math.max((laneEnd.get(name) ?? -1) + 1, ...deps, 0);
    colOf.set(q.id, col);
    laneEnd.set(name, col);
    if (col > maxCol) maxCol = col;
    place.set(q.id, { x: PAD + col * STEP, y: TOP + lane * (laneIdx + 0.5), lane: laneIdx });
  }
  const width = Math.max(scroller.clientWidth, PAD * 2 + maxCol * STEP);
  const highlight = selected ? upstream([selected]) : null;
  const acceptedIds = new Set(goals().flatMap((g) => (g.acceptance ? [g.acceptance] : [])));

  names.replaceChildren(...lanes.map((name) => h("div", { title: name }, name)));
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const rails = lanes.map((_, i) => s("line", { class: "rail", x1: 0, x2: width, y1: TOP + lane * (i + 0.5), y2: TOP + lane * (i + 0.5) }));
  const paths = links.flatMap((l) => {
    // Evidence flows forward: from the question that saved a file to the one that reads it.
    const [from, to] = [place.get(l.target), place.get(l.source)];
    if (!from || !to) return [];
    const lit = highlight?.links.has(linkId(l));
    const files = nodes.get(l.source)!.inputs.filter((i) => i.startsWith(`${l.target}/`)).map((i) => i.slice(l.target.length + 1));
    return [
      s(
        "path",
        {
          d: curve(from, to, lane),
          class: `link needs${highlight ? (lit ? " lit" : " dim") : ""}`,
        },
        files.length ? s("title", {}, document.createTextNode(files.join(", "))) : null,
      ),
    ];
  });
  const glyphs = questions.map((q) => {
    const p = place.get(q.id)!;
    const state = stateOf(q.id);
    const isAccepts = acceptedIds.has(q.id);
    const g = s(
      "g",
      {
        class: `q${isAccepts ? " accepts" : ""}${highlight && !highlight.nodes.has(q.id) && q.id !== selected ? " dim" : ""}`,
        transform: `translate(${p.x} ${p.y})`,
        tabindex: 0,
        role: "button",
        "aria-label": `${state}${isAccepts ? " (acceptance)" : ""}: ${q.text}`,
        "data-id": q.id,
        ...(isAccepts ? { "data-accepts": "true" } : {}),
      },
      s("title", {}, document.createTextNode(q.text)),
      s("circle", { class: "hit", r: 18 }),
      s("circle", { class: "ring hover hover-ring", r: 16.5, opacity: hovered === q.id && selected !== q.id ? 1 : 0 }),
    );
    if (isAccepts) {
      g.append(s("circle", { class: "accept-ring", r: 12.5, style: `--c: ${colour(state)}` }));
      g.append(glyph(state, 6.5));
    } else {
      g.append(glyph(state, 8.5));
    }
    if (q.id === selected) g.append(s("circle", { class: "ring selected", r: 16.5 }));
    else if (marked.has(q.id)) g.append(s("circle", { class: "ring marked", r: 16.5 }));
    g.addEventListener("pointerenter", () => setHovered(q.id));
    g.addEventListener("focus", () => setHovered(q.id));
    g.addEventListener("blur", () => { if (hovered === q.id) setHovered(null); });
    g.addEventListener("click", () => select(q.id));
    g.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        select(q.id);
      } else if (key.startsWith("Arrow")) {
        e.preventDefault();
        focusNeighbor(q.id, key);
      }
    });
    return g;
  });
  svg.replaceChildren(s("g", {}, ...rails), s("g", {}, ...paths), s("g", {}, ...glyphs));
}

/** An artifact dependency. Within one lane it arcs above the questions between. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, lane: number) {
  if (a.y === b.y) {
    const lift = Math.min(lane * 0.44, 12 + Math.abs(b.x - a.x) * 0.16);
    return `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${a.y - lift * 2} ${b.x} ${b.y}`;
  }
  const dx = Math.max(22, (b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

new ResizeObserver(() => scheduleDisplay(true)).observe(el);

function setSidebar(open: boolean) {
  if (!open && sidebar.contains(document.activeElement)) sidebarToggle.focus();
  main.classList.toggle("sidebar-collapsed", !open);
  sidebar.inert = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
  sidebarToggle.setAttribute("aria-expanded", String(open));
  sidebarToggle.textContent = open ? "Hide evidence" : "Show evidence";
}
sidebarToggle.onclick = () => setSidebar(sidebarToggle.getAttribute("aria-expanded") !== "true");

function rememberQuestion(next: string) {
  if (!selected || selected === next) return;
  const panel = document.getElementById("question")!;
  questionHistory.push({
    id: selected,
    scroll: panel.scrollTop,
    lanes: scroller.scrollLeft,
    probeOpen: panel.querySelector<HTMLDetailsElement>("details.probe")?.open ?? false,
    runsOpen: panel.querySelector<HTMLDetailsElement>("details.runs-disclosure")?.open ?? false,
    marked: new Set(marked),
  });
}

function updateEvidenceBack() {
  const previous = questionHistory.at(-1);
  evidenceBack.hidden = !previous;
  evidenceBack.title = previous ? `Back to: ${nodes.get(previous.id)?.text ?? previous.id}` : "";
}
evidenceBack.onclick = () => {
  const previous = questionHistory.pop();
  if (previous) select(previous.id, previous);
};

// ---------------------------------------------------------------------------------------------------------------
// Messages from the hub

let displayFrame: number | null = null;
let lanesDirty = false;
let evidenceDirty = false;

/** Coalesce a burst of records and statuses into one display update. */
function scheduleDisplay(lanes = false, evidence = false) {
  lanesDirty ||= lanes;
  evidenceDirty ||= evidence;
  if (displayFrame !== null) return;
  displayFrame = requestAnimationFrame(() => {
    displayFrame = null;
    const drawLanes = lanesDirty, drawEvidence = evidenceDirty;
    lanesDirty = evidenceDirty = false;
    if (drawLanes) { renderGoals(); render(); }
    if (drawEvidence && selected) showQuestion(selected);
  });
}

/** Chip glyphs can change when a directly linked question changes. */
function panelQuestions() {
  const ids = new Set(selected ? [selected] : []);
  for (const l of links) {
    if (l.source === selected) ids.add(l.target);
    if (l.target === selected) ids.add(l.source);
  }
  return ids;
}

function apply(m: Msg) {
  let evidence = false;
  if (m.type === "graph") {
    for (const st of statements(m.nodes, m.rels)) cypher(st.cypher, st.params);
    evidence = selected !== null && m.rels.some((r) =>
      (r.type === "OF" && r.to === selected) ||
      (r.type === "FOR" && r.from === selected) ||
      (r.type === "ACCEPTED_BY" && r.to === selected) ||
      (r.type === "NEEDS" && (r.from === selected || r.to === selected)));
    for (const n of m.nodes)
      if (n.label === "Question" && !nodes.has(n.id))
        nodes.set(n.id, { id: n.id, text: String(n.props.text), asker: (n.props.asker as string) ?? null, seq: Number(n.props.seq), inputs: n.props.inputs as string[] });
    for (const r of m.rels)
      if (r.type === "NEEDS" && !links.some((l) => l.source === r.from && l.target === r.to))
        links.push({ source: r.from, target: r.to });
  } else if (m.type === "states") {
    const next = new Map(m.states.map((x) => [x.id, x]));
    evidence = [...panelQuestions()].some((id) => JSON.stringify(statuses.get(id)) !== JSON.stringify(next.get(id)));
    statuses = next;
  }
  scheduleDisplay(true, evidence);
}

function connect(delay = 500) {
  const link = document.getElementById("link")!;
  const ws = new WebSocket(new URL("/events", location.href.replace(/^http/, "ws")));
  ws.onopen = () => ((link.textContent = "Connected"), (link.className = "on"));
  ws.onmessage = (e) => apply(JSON.parse(e.data));
  ws.onclose = () => {
    link.textContent = "Reconnecting";
    link.className = "off";
    setTimeout(() => connect(Math.min(delay * 2, 8000)), delay);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Goals

const goalSelect = document.getElementById("goal") as HTMLSelectElement;
let goalSignature = "";

/** The dropdown names the work; the evidence panel shows its acceptance test. */
function renderGoals() {
  const all = goals();
  const signature = JSON.stringify(all.map((g) => [g.id, g.text]));
  if (signature !== goalSignature) {
    goalSignature = signature;
    goalSelect.replaceChildren(
      h("option", { value: "" }, "All questions"),
      ...all.map((g) => {
        const dup = all.filter((other) => other.text === g.text).length > 1;
        return h("option", { value: g.id, title: g.id }, dup ? `${g.text} (${g.id})` : g.text);
      }),
    );
  }
  goalSelect.value = selectedGoal;
  goalSelect.disabled = !all.length;
  if (!goalInitialized && all.length) {
    goalInitialized = true;
    if (!selected) { chooseGoal(all[0]!.id); return; }
  }
  // A newly bound acceptance question opens an otherwise empty goal view.
  if (selectedGoal && !selected) {
    const acceptance = all.find((g) => g.id === selectedGoal)?.acceptance;
    if (acceptance) select(acceptance);
  }
}
goalSelect.onchange = () => chooseGoal(goalSelect.value);

function chooseGoal(id: string) {
  selectedGoal = id;
  goalInitialized = true;
  selected = null;
  marked.clear();
  questionHistory.length = 0;
  updateEvidenceBack();
  renderGoals();
  const g = goals().find((g) => g.id === id);
  if (g?.acceptance) select(g.acceptance);
  else {
    if (!id) scroller.scrollLeft = 0;
    document.getElementById("question")!.replaceChildren(
      ...(g ? [h("h2", {}, g.text)] : []),
      h("p", { class: "hint" }, g ? "No acceptance question." : "Select a question."),
    );
    render();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The evidence panel

function badge(st: Status | undefined) {
  const state = st?.state ?? "waiting";
  const answered = state === "yes" || state === "no";
  return h("span", { class: `badge${answered ? "" : " hollow"}`, style: `--c: ${colour(state)}` }, state);
}

/** An id in a table: clickable, with its answer's glyph. */
function ref(q: string) {
  const accepts = goals().some((g) => g.acceptance === q);
  const a = h("span", { class: "ref id" }, mark(stateOf(q), 10, accepts), q);
  a.onclick = () => select(q);
  return a;
}

/** Another question, by its text. */
function chip(q: string) {
  const accepts = goals().some((g) => g.acceptance === q);
  const b = h("button", { type: "button", class: "chip", title: q }, mark(stateOf(q), 12, accepts), h("span", {}, nodes.get(q)?.text ?? q));
  b.onclick = () => select(q);
  return b;
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;

/** What the panel shows about a question. A browser agent gets the same (page/tools.ts). */
function details(qid: string) {
  const [q] = cypher("MATCH (q:Question {id: $selected}) RETURN q.text AS text, q.rule AS rule, q.probe AS probe, q.inputs AS inputs, q.asker AS asker", { selected: qid });
  if (!q) return null;
  const st = statuses.get(qid);
  const [l] = cypher(
    `MATCH (q:Question {id: $selected})
     OPTIONAL MATCH (q)-[:NEEDS]->(n:Question) WITH q, collect(DISTINCT n.id) AS needs
     OPTIONAL MATCH (m:Question)-[:NEEDS]->(q)
     RETURN needs, collect(DISTINCT m.id) AS neededBy`,
    { selected: qid },
  );
  const runs = cypher(
    `MATCH (r:Run)-[:OF]->(:Question {id: $selected})
     RETURN r.id AS run, r.seq AS seq, r.answer AS answer, r.reason AS reason, r.results AS results, r.ms AS ms ORDER BY r.seq DESC`,
    { selected: qid },
  );
  // Show measurements only from the committed run that gives this answer.
  const shown = runs.find((r) => r.run === st?.run);
  const results: unknown[] = shown ? JSON.parse(String(shown.results)) : [];
  const saved = shown ? cypher("MATCH (:Run {id: $run})-[s:SAVED]->(f:File) RETURN s.name AS name, f.id AS file ORDER BY name", { run: shown.run }) : [];
  const read = shown ? cypher("MATCH (:Run {id: $run})-[s:READ]->(f:File) RETURN s.name AS name, f.id AS file ORDER BY name", { run: shown.run }) : [];
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const files = (rows: Row[]) => rows.map((f) => ({ name: String(f.name), url: `/files/${f.file}?name=${encodeURIComponent(String(f.name))}` }));
  return {
    id: qid,
    text: String(q.text),
    rule: String(q.rule),
    probe: String(q.probe),
    inputs: ids(q.inputs),
    asker: (q.asker as string | null) ?? null,
    explores: cypher("MATCH (:Question {id: $id})-[:FOR]->(g:Goal) RETURN g.id AS id, g.text AS text", { id: qid }),
    accepts: cypher("MATCH (g:Goal)-[:ACCEPTED_BY]->(:Question {id: $id}) RETURN g.id AS id, g.text AS text", { id: qid }),
    status: st,
    restsOn: ids(l?.needs),
    usedBy: ids(l?.neededBy),
    ran: Boolean(shown),
    results,
    read: files(read),
    saved: files(saved),
    runs: runs.map((r) => ({ run: String(r.run), seq: Number(r.seq), ms: Number(r.ms), answer: String(r.answer), reason: (r.reason as string | null) ?? null, current: r.run === st?.run })),
  };
}

/** Display recorded values without rounding, inferred units or invented field names. */
function show(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * Each part of the rule, the measurements it names, and whether it held on these measurements. The page works this
 * out on its own Relate copy, for reading. The answer itself is the run's.
 */
function ruleCheck(rule: string, results: unknown[], ran: boolean) {
  const m = measurements(results as Record<string, unknown>[]);
  const parts = clauses(rule);
  const shownNames = new Set<string>();
  const rows = parts.map((clause) => {
    let verdict: { word: string; state: State };
    if (!ran) verdict = { word: "not run yet", state: "waiting" };
    else if (!results.length) verdict = { word: "not measured", state: "failed" };
    else
      try {
        const v = execute(`RETURN (${clause}) AS v`, m).rows[0]?.v;
        verdict = v === true ? { word: "true", state: "yes" } : v === false ? { word: "false", state: "no" } : { word: "not true or false", state: "failed" };
      } catch (e) {
        verdict = { word: /ParameterMissing/.test((e as Error).message) ? "not measured" : "cannot be checked", state: "failed" };
      }
    const values = named(clause).filter((n) => n !== "results" && n in m);
    for (const n of values) shownNames.add(n);
    return h(
      "li",
      { class: "clause", style: `--c: ${colour(verdict.state)}` },
      h("code", {}, clause),
      h("span", { class: "mark" }, verdict.word),
      values.length ? h("div", { class: "values" }, ...values.map((n) => h("span", {}, h("small", {}, n), show(m[n])))) : null,
    );
  });
  return { element: h("div", { class: "rule-check" }, h("h3", {}, "Rule"), h("ul", { class: "clauses" }, ...rows)), shownNames };
}

function measurementTable(entries: [string, unknown][], multipleRecords: boolean) {
  return h(
    "table",
    { class: "measurements", "aria-label": "Measurements" },
    h("thead", {}, h("tr", {}, h("th", {}, "Measurement"), h("th", {}, multipleRecords ? "Last value" : "Value"))),
    h("tbody", {}, ...entries.map(([key, value]) => h("tr", {}, h("th", { scope: "row" }, key), h("td", {}, h("code", {}, show(value)))))),
  );
}

function showQuestion(qid: string) {
  const d = details(qid);
  if (!d) return;
  const panel = document.getElementById("question")!;
  const keepProbeOpen = panel.querySelector<HTMLDetailsElement>("details.probe")?.open ?? false;
  const keepRunsOpen = panel.querySelector<HTMLDetailsElement>("details.runs-disclosure")?.open ?? false;
  const st = d.status;
  const pictures = d.saved.filter((f) => IMAGE.test(f.name));
  // Why it failed, or what it waits for. A replay's states leave it out, so fall back to the current run's.
  const reason = st?.reason ?? d.runs.find((r) => r.current)?.reason ?? null;
  const list = (title: string, qs: string[]) => (qs.length ? [h("h3", {}, title), h("div", {}, ...qs.map(chip))] : []);
  const { element: ruleEl, shownNames } = ruleCheck(d.rule, d.results, d.ran);
  const latest = Object.assign({}, ...(d.results as Record<string, unknown>[])) as Record<string, unknown>;
  // Measurements already printed inside Rule clauses are not repeated in a second table right below.
  const extraEntries = Object.entries(latest).filter(([k]) => !shownNames.has(k));
  const probeDetails = h("details", { class: "probe" }, h("summary", {}, "Probe"), h("pre", {}, d.probe)) as HTMLDetailsElement;
  probeDetails.open = keepProbeOpen;
  const runsCount = d.runs.length;
  const runsDetails = runsCount
    ? (h(
        "details",
        { class: "runs-disclosure" },
        h("summary", {}, `${runsCount} ${runsCount === 1 ? "run" : "runs"}`),
        h(
          "ul",
          { class: "runs" },
          ...d.runs.map((r) =>
            h(
              "li",
              {},
              h("span", { class: "badge", style: `--c: ${colour(r.answer as State)}` }, r.answer),
              h("span", { class: "id", title: `#${r.seq}` }, r.run),
              h("span", { class: "hint" }, `${r.ms} ms`),
              r.current ? h("span", { class: "hint" }, "current") : null,
              r.reason ? h("span", { class: "reason-line" }, r.reason.split("\n")[0]!) : null,
            ),
          ),
        ),
      ) as HTMLDetailsElement)
    : null;
  if (runsDetails) runsDetails.open = keepRunsOpen;

  const parts: (HTMLElement | null)[] = [
    h(
      "div",
      { class: "verdict" },
      badge(st),
      st?.was ? h("span", {}, `was ${st.was}`) : null,
      d.accepts.length ? h("span", {}, "acceptance") : null,
      h("span", { class: "id" }, qid),
    ),
    h("h2", {}, d.text),
    d.asker ? h("p", { class: "provenance" }, "Asked by ", h("span", {}, d.asker)) : null,
    ruleEl,
    reason ? h("p", { class: "reason" }, reason) : null,
    ...(pictures.length
      ? [h("h3", {}, "Images"), ...pictures.map((f) => h("figure", {}, h("img", { src: f.url, alt: f.name }), h("figcaption", {}, h("a", { href: f.url, target: "_blank" }, f.name))))]
      : []),
    ...(extraEntries.length
      ? [h("h3", {}, "Measurements"), measurementTable(extraEntries, d.results.length > 1)]
      : []),
    ...(d.results.length > 1
      ? [h("details", { class: "raw-measurements" }, h("summary", {}, "All measurements"), h("pre", {}, d.results.map((x) => JSON.stringify(x)).join("\n")))]
      : []),
    ...(d.inputs.length || d.saved.length
      ? [
          h("h3", {}, "Files"),
          h(
            "table",
            { class: "files", "aria-label": "Files" },
            h(
              "tbody",
              {},
              ...d.inputs.map((name) => {
                const f = d.read.find((f) => f.name === name);
                return h("tr", {}, h("td", {}, f ? h("a", { href: f.url, target: "_blank" }, name) : h("code", {}, name)), h("td", {}, "input"));
              }),
              ...d.saved.map((f) => h("tr", {}, h("td", {}, h("a", { href: f.url, target: "_blank" }, f.name)), h("td", {}, "saved"))),
            ),
          ),
        ]
      : []),
    ...list("Depends on", d.restsOn),
    ...list("Used by", d.usedBy),
    h("div", { class: "disclosures" }, probeDetails, runsDetails),
  ];
  panel.replaceChildren(...parts.filter((x) => x !== null));
}

function select(qid: string, previous?: QuestionVisit) {
  if (!previous) rememberQuestion(qid);
  if (previous) marked = new Set(previous.marked);
  selected = qid;
  updateEvidenceBack();
  setSidebar(true);
  showQuestion(qid);
  const panel = document.getElementById("question")!;
  const probe = panel.querySelector<HTMLDetailsElement>("details.probe");
  const runs = panel.querySelector<HTMLDetailsElement>("details.runs-disclosure");
  if (probe && previous) probe.open = previous.probeOpen;
  if (runs && previous) runs.open = previous.runsOpen;
  panel.scrollTop = previous?.scroll ?? 0;
  render();
  if (previous) {
    scroller.scrollLeft = previous.lanes;
    if (evidenceBack.hidden) {
      const heading = panel.querySelector("h2")!;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    return;
  }
  const x = place.get(qid)?.x;
  if (x !== undefined && (x - PAD < scroller.scrollLeft || x + PAD > scroller.scrollLeft + scroller.clientWidth))
    scroller.scrollLeft = Math.max(0, x + PAD - scroller.clientWidth);
}

// ---------------------------------------------------------------------------------------------------------------
// Queries (docked under the lanes so Evidence stays visible)

const PRESETS: [string, string][] = [
  ["What is each goal’s acceptance question?", "MATCH (g:Goal)\nOPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)\nRETURN g.id AS goal, g.text AS text, q.id AS acceptance, q.id IN $yes AS yes ORDER BY g.seq"],
  ["What does the selected question use?", "MATCH (q:Question {id: $selected})-[:NEEDS*0..]->(u:Question)\nRETURN DISTINCT u.id AS id, u.text AS text, u.seq AS seq ORDER BY seq"],
  ["Which questions answer yes?", "MATCH (q:Question)\nWHERE q.id IN $yes\nRETURN q.id AS id, q.text AS text ORDER BY q.seq"],
  ["What is each rule?", "MATCH (q:Question)\nRETURN q.id AS id, q.rule AS rule, q.id IN $yes AS yes ORDER BY q.seq"],
  ["Which questions read each file?", "MATCH (q:Question)<-[:OF]-(r:Run)-[x:READ]->(:File)\nWHERE r.id IN $current AND NOT x.name STARTS WITH 'q-'\nRETURN x.name AS input, count(DISTINCT q) AS read_by, collect(DISTINCT q.id) AS questions ORDER BY input"],
  ["Which questions read from the same question?", "MATCH (a:Question)-[:NEEDS]->(u:Question)<-[:NEEDS]-(b:Question)\nWHERE a.seq < b.seq\nRETURN u.id AS output_of, a.id AS a, b.id AS b"],
  ["Which runs failed, and why?", "MATCH (r:Run {answer: 'failed'})-[:OF]->(q:Question)\nRETURN q.id AS id, r.reason AS reason, r.seq AS seq ORDER BY seq DESC"],
  ["What did each asker ask?", "MATCH (q:Question)\nRETURN q.asker AS asker, count(*) AS questions,\n  sum(CASE WHEN q.id IN $yes THEN 1 ELSE 0 END) AS yes,\n  sum(CASE WHEN q.id IN $no THEN 1 ELSE 0 END) AS no\nORDER BY questions DESC"],
];

const queryToggle = document.getElementById("query-toggle") as HTMLButtonElement;
const querySection = document.getElementById("query")!;
const preset = document.getElementById("preset") as HTMLSelectElement;
const text = document.getElementById("cypher") as HTMLTextAreaElement;

function setQueryOpen(open: boolean) {
  querySection.hidden = !open;
  queryToggle.setAttribute("aria-expanded", String(open));
  queryToggle.textContent = open ? "▾ Query" : "▸ Query";
}
queryToggle.onclick = () => setQueryOpen(Boolean(querySection.hidden));

preset.replaceChildren(...PRESETS.map(([name], i) => h("option", { value: String(i) }, name)));
preset.onchange = () => {
  text.value = PRESETS[Number(preset.value)]![1];
  runQuery();
};
text.value = PRESETS[0]![1];

/** Question ids in a value: the value itself, or the items of a list. */
const idsIn = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(idsIn) : typeof v === "string" && nodes.has(v) ? [v] : []);

/** The parameters every query in the page gets: the answers now, and the selected question and its current run. */
const params = () => ({
  ...answerParams([...statuses.values()], goals()),
  selected,
  run: (selected && statuses.get(selected)?.run) ?? null,
});

/** Runs the Query drawer's Cypher, shows the rows, and marks the questions they name. Returns the rows, or the error. */
function runQuery(): { columns: string[]; rows: Row[] } | Error {
  const out = document.getElementById("rows")!;
  if (text.value.includes("$selected") && !selected) {
    out.replaceChildren(h("p", { class: "hint" }, "Select a question first."));
    return new Error("No question is selected, and this query uses $selected. Select one first.");
  }
  try {
    const r = result(text.value, params());
    marked = new Set(r.rows.flatMap((row) => Object.values(row).flatMap(idsIn)));
    render();
    const cell = (v: unknown): Node | string => {
      const found = idsIn(v);
      if (found.length && (typeof v === "string" || (Array.isArray(v) && found.length === v.length)))
        return h("span", {}, ...found.flatMap((x, i) => (i ? [" ", ref(x)] : [ref(x)])));
      return typeof v === "string" ? v : JSON.stringify(v);
    };
    out.replaceChildren(
      r.rows.length
        ? h("table", {}, h("tr", {}, ...r.columns.map((c) => h("th", {}, c))), ...r.rows.map((row) => h("tr", {}, ...r.columns.map((c) => h("td", {}, cell(row[c]))))))
        : h("p", { class: "hint" }, "No rows."),
    );
    return r;
  } catch (e) {
    marked = new Set();
    render();
    out.replaceChildren(h("p", { class: "error" }, (e as Error).message));
    return e as Error;
  }
}
document.getElementById("run")!.onclick = () => runQuery();

/** Opens the Query drawer, puts a query there, and runs it while Evidence stays open on the right. */
function showQuery(query: string) {
  text.value = query;
  preset.selectedIndex = PRESETS.findIndex(([, q]) => q === query);
  setQueryOpen(true);
  return runQuery();
}

renderGoals();
render();
connect();

// The page's tools for a browser agent (WebMCP), on the page's own functions.
const tools = webTools({
  operators(query) {
    const { plan } = execute(`EXPLAIN ${query}`, params());
    if (!plan) throw new Error("Relate gave no plan for this query, so the page cannot tell that it only reads.");
    const walk = (n: Plan["root"]): string[] => [n.operator, ...n.children.flatMap(walk)];
    return walk(plan.root);
  },
  query: showQuery,
  question(qid) {
    if (!nodes.has(qid)) return null;
    select(qid);
    return details(qid);
  },
});
register(tools);

// For tests and the browser console: read the page's copy of the graph, and call the page's tools.
Object.assign(window, { witness: { cypher, select, tools, state: (q: string) => statuses.get(q)?.state ?? null, questions: () => nodes.size } });
