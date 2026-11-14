/// <reference lib="dom" />
// The live page. It keeps its own copy of the graph in Relate (WASM), built by the same statements the hub runs,
// and answers every panel and query with Cypher in the page. The hub sends new records and states.
//
// The lanes show how the agents got here: one row per direction of work, questions in the order they were asked.
// The rule check shows why an answer stands: each part of the rule, the measurements it names, and whether it held.
// DESIGN.md gives the tokens and the reasons.
import init, { RelateDb } from "@relate/relate-wasm";
import wasmUrl from "@relate/relate-wasm/relate_bg.wasm" with { type: "file" };
import { answerParams, clauses, type GNode, type GRel, measurements, named, type State, type Status, statements } from "../src/graph.ts";
import { type Navigation, register, webTools } from "./tools.ts";

type Msg =
  | { type: "graph"; nodes: GNode[]; rels: GRel[] }
  | { type: "states"; states: Status[] };

type QNode = { id: string; text: string; asker: string | null; seq: number };
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
let marked = new Set<string>();
type Neighborhood = { nodes: Set<string>; links: Set<string> };
let focus: Neighborhood | null = null;
type QuestionVisit = { id: string; scroll: number; lanes: number; probeOpen: boolean; focus: Neighborhood | null; marked: Set<string>; summary: string };
const questionHistory: QuestionVisit[] = [];
const linkId = (l: QLink) => `${l.source}:${l.target}`;
const stateOf = (q: string): State => statuses.get(q)?.state ?? "waiting";
const colour = (s: State) => `var(--${s === "pending" ? "running" : s})`;

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

/** A glyph on its own, for text: the header, chips and refs. */
function mark(state: State, size = 12) {
  const half = size / 2;
  return s("svg", { width: size, height: size, viewBox: `${-half} ${-half} ${size} ${size}`, "aria-hidden": "true" }, glyph(state, half - 1.5));
}

// ---------------------------------------------------------------------------------------------------------------
// The lanes

const main = document.querySelector("main")!;
const el = document.getElementById("graph")!;
const sidebar = document.getElementById("sidebar")!;
const sidebarToggle = document.getElementById("sidebar-toggle")!;
const evidenceBack = document.getElementById("evidence-back") as HTMLButtonElement;
const names = h("div", { class: "lane-names", "aria-hidden": "true" });
const scroller = h("div", { class: "lanes" });
const svg = s("svg", { role: "group", "aria-label": "Questions by direction of work, in the order they were asked" }) as SVGSVGElement;
const legend = (kind: string, words: string) => h("span", {}, s("svg", { width: 22, height: 6, "aria-hidden": "true" }, s("line", { class: `link ${kind}`, x1: 0, x2: 22, y1: 3, y2: 3 })), words);
scroller.append(svg, h("p", { class: "caption" }, legend("needs", "depends on")));
const empty = h("p", { class: "empty" }, "No questions yet.");

const TOP = 44; // Room for the walkthrough bar.
const PAD = 28;
/** Where each question sits, from the last render. */
const place = new Map<string, { x: number; y: number }>();

/** The lane of an asker: the part after the last /, before the first -. orchestrator/evolution and evolution-tools share one. */
const laneOf = (asker: string | null) => {
  const last = (asker ?? "").split("/").at(-1)!.trim();
  return (last.split("-")[0] || last || "unnamed").replaceAll("_", " ");
};

function render() {
  updateTour();
  const questions = [...nodes.values()].sort((a, b) => a.seq - b.seq);
  if (!questions.length) {
    el.replaceChildren(empty);
    return;
  }
  if (!scroller.isConnected) el.replaceChildren(names, scroller);
  const lanes = [...new Set(questions.map((q) => laneOf(q.asker)))];
  // Lanes share the height there is, within limits that keep them readable.
  const lane = Math.round(Math.max(56, Math.min(104, (el.clientHeight - TOP - 56) / lanes.length)));
  el.style.setProperty("--lane", `${lane}px`);
  const col = Math.max(36, Math.min(88, (scroller.clientWidth - 2 * PAD) / Math.max(1, questions.length - 1)));
  const width = Math.max(scroller.clientWidth, 2 * PAD + col * (questions.length - 1));
  const height = TOP + lane * lanes.length;
  place.clear();
  questions.forEach((q, i) => place.set(q.id, { x: PAD + i * col, y: TOP + lane * (lanes.indexOf(laneOf(q.asker)) + 0.5) }));

  names.replaceChildren(...lanes.map((name) => h("div", { title: name }, name)));
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const rails = lanes.map((_, i) => s("line", { class: "rail", x1: 0, x2: width, y1: TOP + lane * (i + 0.5), y2: TOP + lane * (i + 0.5) }));
  const paths = links.flatMap((l) => {
    // Evidence flows forward: from the question that saved a file to the one that reads it.
    const [from, to] = [place.get(l.target), place.get(l.source)];
    if (!from || !to) return [];
    const lit = focus?.links.has(linkId(l));
    return [
      s("path", {
        d: curve(from, to, lane),
        class: `link needs${focus ? (lit ? " lit" : " dim") : ""}`,
      }),
    ];
  });
  const glyphs = questions.map((q) => {
    const p = place.get(q.id)!;
    const state = stateOf(q.id);
    const g = s(
      "g",
      {
        class: `q${focus && !focus.nodes.has(q.id) ? " dim" : ""}`,
        transform: `translate(${p.x} ${p.y})`,
        tabindex: 0,
        role: "button",
        "aria-label": `${state}: ${q.text}`,
        "data-id": q.id,
      },
      s("title", {}, document.createTextNode(q.text)),
      s("circle", { class: "hit", r: 15 }),
    );
    g.append(glyph(state, 9));
    if (q.id === selected) g.append(s("circle", { class: "ring selected", r: 13.5 }));
    else if (marked.has(q.id) || focus?.nodes.has(q.id)) g.append(s("circle", { class: "ring marked", r: 13.5 }));
    g.addEventListener("click", () => select(q.id));
    g.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
        e.preventDefault();
        select(q.id);
      }
    });
    return g;
  });
  svg.replaceChildren(s("g", {}, ...rails), s("g", {}, ...paths), s("g", {}, ...glyphs));
}

/** An artifact dependency. Within one lane it arcs above the questions between. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, lane: number) {
  if (a.y === b.y) {
    const lift = Math.min(lane * 0.42, 10 + Math.abs(b.x - a.x) * 0.18);
    return `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${a.y - lift * 2} ${b.x} ${b.y}`;
  }
  const dx = Math.max(24, (b.x - a.x) / 2);
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

/** The scroll position that puts these questions in the middle of the lanes. */
function centre(ids: Set<string>) {
  const xs = [...ids].flatMap((q) => place.get(q)?.x ?? []);
  if (!xs.length) return scroller.scrollLeft;
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  return Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, mid - scroller.clientWidth / 2));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function rememberQuestion(next: string) {
  if (!selected || selected === next) return;
  const panel = document.getElementById("question")!;
  questionHistory.push({
    id: selected, scroll: panel.scrollTop, lanes: scroller.scrollLeft,
    probeOpen: panel.querySelector("details")?.open ?? false,
    focus, marked: new Set(marked), summary: document.getElementById("navigation-summary")!.textContent ?? "",
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

function navigate({ id: start = selected ?? undefined, relation, depth = 1 }: Navigation, fromSequence = false) {
  if (relation === "overview") {
    focus = null;
    marked.clear();
    document.getElementById("navigation")!.hidden = true;
    render();
    scroller.scrollLeft = 0;
    return { relation, questions: nodes.size, selected };
  }
  if (!start) throw new Error("Select a question or give its id first.");
  if (!nodes.has(start)) throw new Error(`There is no question ${start}. Call query to list the questions already in the page.`);
  const found = new Set([start]);
  const followed = new Map<string, QLink>();
  let frontier = new Set([start]);
  for (let step = 0; step < depth && frontier.size; step++) {
    const next = new Set<string>();
    for (const l of links) {
      const { source: from, target: to } = l;
      const targets = [relation === "dependencies" ? (frontier.has(from) ? to : null) : frontier.has(to) ? from : null];
      for (const target of targets)
        if (target) {
          followed.set(linkId(l), l);
          if (!found.has(target)) {
            found.add(target);
            next.add(target);
          }
        }
    }
    frontier = next;
  }
  // Previous/Next follow question order. Back follows links between questions.
  if (fromSequence) questionHistory.length = 0;
  else rememberQuestion(start);
  selected = start;
  updateEvidenceBack();
  marked.clear();
  focus = { nodes: found, links: new Set(followed.keys()) };
  document.getElementById("navigation")!.hidden = false;
  document.getElementById("navigation-summary")!.textContent =
    `${relation[0]!.toUpperCase() + relation.slice(1)}: ${plural(found.size, "question")}, ${plural(followed.size, "link")}, depth ${depth}`;

  tab("question", false);
  showQuestion(start);
  document.getElementById("question")!.scrollTop = 0;
  setSidebar(true);
  // Opening the panel can change the lane viewport. Use its final dimensions.
  render();
  scroller.scrollLeft = centre(found);
  return {
    id: start,
    relation,
    depth,
    questions: [...found].map((qid) => ({ id: qid, text: nodes.get(qid)!.text, answer: stateOf(qid) })),
    links: [...followed.values()].map((l) => ({ from: l.source, to: l.target, type: "NEEDS" })),
  };
}
document.getElementById("overview")!.onclick = () => navigate({ relation: "overview" });

// ---------------------------------------------------------------------------------------------------------------
// Manual navigation visits every question in asking order, including negative answers and failed measurements.

const tourPrevious = document.getElementById("tour-previous") as HTMLButtonElement;
const tourNext = document.getElementById("tour-next") as HTMLButtonElement;
const tourSeek = document.getElementById("tour-seek") as HTMLInputElement;
const tourQuestions = () => [...nodes.values()].sort((a, b) => a.seq - b.seq);
const tourIndex = () => tourQuestions().findIndex((q) => q.id === selected);

function updateTour() {
  const questions = tourQuestions();
  const position = questions.findIndex((q) => q.id === selected);
  const current = questions[position];
  document.getElementById("tour-progress")!.textContent = !questions.length
    ? "No questions yet"
    : current ? `${position + 1} of ${questions.length}` : plural(questions.length, "question");
  document.getElementById("tour-title")!.textContent = current?.text ?? "";
  tourPrevious.disabled = position <= 0;
  tourNext.disabled = position >= questions.length - 1;
  tourSeek.disabled = !questions.length;
  tourSeek.max = String(Math.max(0, questions.length - 1));
  tourSeek.value = String(Math.max(0, position));
  tourSeek.setAttribute("aria-valuetext", current ? `Question ${position + 1} of ${questions.length}: ${current.text}` : "No questions yet");
}

function visitTour(index: number) {
  const question = tourQuestions()[index];
  if (!question) return;
  navigate({ id: question.id, relation: "dependencies", depth: 1 }, true);
}

tourPrevious.onclick = () => visitTour(tourIndex() - 1);
tourNext.onclick = () => visitTour(tourIndex() + 1);
tourSeek.oninput = () => visitTour(Number(tourSeek.value));

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
    if (drawLanes) { render(); counts(); }
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
      (r.type === "NEEDS" && (r.from === selected || r.to === selected)));
    for (const n of m.nodes)
      if (n.label === "Question" && !nodes.has(n.id))
        nodes.set(n.id, { id: n.id, text: String(n.props.text), asker: (n.props.asker as string) ?? null, seq: Number(n.props.seq) });
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
// The header: answers by kind.

function counts() {
  const all = [...statuses.values()];
  const box = document.getElementById("counts")!;
  if (!all.length) return box.replaceChildren();
  box.replaceChildren(
    ...(["yes", "no", "failed", "running", "pending", "waiting"] as State[])
      .map((st) => [st, all.filter((x) => x.state === st).length] as const)
      .filter(([, n]) => n)
      .map(([st, n]) => h("span", { class: "count" }, mark(st), h("b", {}, String(n)), ` ${st}`)),
  );
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
  const a = h("span", { class: "ref id" }, mark(stateOf(q), 10), q);
  a.onclick = () => select(q);
  return a;
}

/** Another question, by its text. */
function chip(q: string) {
  const b = h("button", { class: "chip", title: q }, mark(stateOf(q)), h("span", {}, nodes.get(q)?.text ?? q));
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
     RETURN r.id AS run, r.seq AS seq, r.answer AS answer, r.reason AS reason, r.results AS results ORDER BY r.seq DESC`,
    { selected: qid },
  );
  // Show measurements only from the committed run that gives this answer.
  const shown = runs.find((r) => r.run === st?.run);
  const results: unknown[] = shown ? JSON.parse(String(shown.results)) : [];
  const saved = shown ? cypher("MATCH (:Run {id: $run})-[s:SAVED]->(f:File) RETURN s.name AS name, f.id AS file ORDER BY name", { run: shown.run }) : [];
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    id: qid,
    text: String(q.text),
    rule: String(q.rule),
    probe: String(q.probe),
    inputs: ids(q.inputs),
    asker: (q.asker as string | null) ?? null,
    status: st,
    restsOn: ids(l?.needs),
    usedBy: ids(l?.neededBy),
    ran: Boolean(shown),
    results,
    saved: saved.map((f) => ({ name: String(f.name), url: `/files/${f.file}?name=${encodeURIComponent(String(f.name))}` })),
    runs: runs.map((r) => ({ run: String(r.run), seq: Number(r.seq), answer: String(r.answer), reason: (r.reason as string | null) ?? null, current: r.run === st?.run })),
  };
}

/** A measured value, short enough to read at a glance. */
function show(v: unknown): string {
  if (typeof v === "number") {
    const a = Math.abs(v);
    const text = Number.isInteger(v) ? v.toLocaleString("en-US") : a !== 0 && (a < 1e-3 || a >= 1e6) ? v.toExponential(3) : String(Number(v.toPrecision(5)));
    return text.replace("-", "−");
  }
  if (typeof v === "string") return `'${v}'`;
  const json = JSON.stringify(v);
  return json.length > 64 ? `${json.slice(0, 62)}…` : json;
}

/**
 * Each part of the rule, the measurements it names, and whether it held on these measurements. The page works this
 * out on its own Relate copy, for reading. The answer itself is the run's.
 */
function ruleCheck(rule: string, results: unknown[], ran: boolean) {
  const m = measurements(results as Record<string, unknown>[]);
  const parts = clauses(rule);
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
    return h(
      "li",
      { class: "clause", style: `--c: ${colour(verdict.state)}` },
      h("code", {}, clause),
      h("span", { class: "mark" }, verdict.word),
      values.length ? h("div", { class: "values" }, ...values.map((n) => h("span", {}, h("small", {}, n), show(m[n])))) : null,
    );
  });
  return h("div", { class: "rule-check" }, h("h3", {}, "Yes when"), h("ul", { class: "clauses" }, ...rows));
}

function showQuestion(qid: string) {
  const d = details(qid);
  if (!d) return;
  const st = d.status;
  const pictures = d.saved.filter((f) => IMAGE.test(f.name));
  const files = d.saved.filter((f) => !IMAGE.test(f.name));
  // Why it failed, or what it waits for. A replay's states leave it out, so fall back to the current run's.
  const reason = st?.reason ?? d.runs.find((r) => r.current)?.reason ?? null;
  const list = (title: string, qs: string[]) => (qs.length ? [h("h3", {}, title), h("div", {}, ...qs.map(chip))] : []);
  const parts: (HTMLElement | null)[] = [
    h("div", { class: "verdict" }, badge(st), st?.was ? h("span", {}, `was ${st.was}`) : null, h("span", { class: "id" }, qid), d.asker ? h("span", {}, d.asker) : null),
    h("h2", {}, d.text),
    ruleCheck(d.rule, d.results, d.ran),
    reason ? h("p", { class: "reason" }, reason) : null,
    ...(pictures.length
      ? [h("h3", {}, "Images"), ...pictures.map((f) => h("figure", {}, h("img", { src: f.url, alt: f.name }), h("figcaption", {}, h("a", { href: f.url, target: "_blank" }, f.name))))]
      : []),
    ...list("Depends on", d.restsOn),
    ...list("Used by", d.usedBy),
    ...(files.length ? [h("h3", {}, "Files"), h("ul", {}, ...files.map((f) => h("li", {}, h("a", { href: f.url, target: "_blank" }, f.name))))] : []),
    ...(d.inputs.length ? [h("h3", {}, "Inputs"), h("ul", {}, ...d.inputs.map((i) => h("li", { class: "id" }, i)))] : []),
    d.results.length ? h("h3", {}, "Measurements") : null,
    d.results.length ? h("pre", {}, d.results.map((x) => JSON.stringify(x)).join("\n")) : null,
    ...(d.runs.length
      ? [
          h("h3", {}, "Runs"),
          h(
            "ul",
            { class: "runs" },
            ...d.runs.map((r) =>
              h(
                "li",
                {},
                h("span", { class: "badge", style: `--c: ${colour(r.answer as State)}` }, r.answer),
                h("span", { class: "id" }, `#${r.seq}`),
                r.current ? h("span", { class: "hint" }, "current") : null,
                r.reason ? h("span", { class: "reason-line" }, r.reason.split("\n")[0]!) : null,
              ),
            ),
          ),
        ]
      : []),
    h("details", {}, h("summary", {}, "Probe"), h("pre", {}, d.probe)),
  ];
  document.getElementById("question")!.replaceChildren(...parts.filter((x) => x !== null));
}

function select(qid: string, previous?: QuestionVisit) {
  if (!previous) rememberQuestion(qid);
  focus = previous?.focus ?? null;
  if (previous) marked = new Set(previous.marked);
  document.getElementById("navigation")!.hidden = !focus;
  if (previous) document.getElementById("navigation-summary")!.textContent = previous.summary;
  selected = qid;
  updateEvidenceBack();
  tab("question");
  showQuestion(qid);
  const panel = document.getElementById("question")!;
  const probe = panel.querySelector("details");
  if (probe && previous) probe.open = previous.probeOpen;
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
  if (x !== undefined && (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth)) scroller.scrollLeft = x - scroller.clientWidth / 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

const PRESETS: [string, string][] = [
  ["What does the selected question use?", "MATCH (q:Question {id: $selected})-[:NEEDS*0..]->(u:Question)\nRETURN DISTINCT u.id AS id, u.text AS text, u.seq AS seq ORDER BY seq"],
  ["Which questions answer yes?", "MATCH (q:Question)\nWHERE q.id IN $yes\nRETURN q.id AS id, q.text AS text ORDER BY q.seq"],
  ["What is each rule?", "MATCH (q:Question)\nRETURN q.id AS id, q.rule AS rule, q.id IN $yes AS yes ORDER BY q.seq"],
  ["Which questions read each file?", "MATCH (q:Question)<-[:OF]-(r:Run)-[x:READ]->(:File)\nWHERE r.id IN $current AND NOT x.name STARTS WITH 'q-'\nRETURN x.name AS input, count(DISTINCT q) AS read_by, collect(DISTINCT q.id) AS questions ORDER BY input"],
  ["Which questions read from the same question?", "MATCH (a:Question)-[:NEEDS]->(u:Question)<-[:NEEDS]-(b:Question)\nWHERE a.seq < b.seq\nRETURN u.id AS output_of, a.id AS a, b.id AS b"],
  ["Which runs failed, and why?", "MATCH (r:Run {answer: 'failed'})-[:OF]->(q:Question)\nRETURN q.id AS id, r.reason AS reason, r.seq AS seq ORDER BY seq DESC"],
  ["What did each asker ask?", "MATCH (q:Question)\nRETURN q.asker AS asker, count(*) AS questions,\n  sum(CASE WHEN q.id IN $yes THEN 1 ELSE 0 END) AS yes,\n  sum(CASE WHEN q.id IN $no THEN 1 ELSE 0 END) AS no\nORDER BY questions DESC"],
];

const preset = document.getElementById("preset") as HTMLSelectElement;
const text = document.getElementById("cypher") as HTMLTextAreaElement;
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
  ...answerParams([...statuses.values()]),
  selected,
  run: (selected && statuses.get(selected)?.run) ?? null,
});

/** Runs the Query tab's Cypher, shows the rows, and marks the questions they name. Returns the rows, or the error. */
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

/** Puts a query in the Query tab and runs it there. The menu names it when it is a preset, and shows nothing else. */
function showQuery(query: string) {
  text.value = query;
  preset.selectedIndex = PRESETS.findIndex(([, q]) => q === query);
  tab("query");
  return runQuery();
}

function tab(name: string, open = true) {
  if (open) setSidebar(true);
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button[data-tab]")) b.classList.toggle("on", b.dataset.tab === name);
  for (const sec of document.querySelectorAll<HTMLElement>("aside section")) sec.hidden = sec.id !== name;
}
for (const b of document.querySelectorAll<HTMLButtonElement>("nav button[data-tab]")) b.onclick = () => tab(b.dataset.tab!);

render();
connect();

// The page's tools for a browser agent (WebMCP), on the page's own functions.
const tools = webTools({
  navigate,
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
