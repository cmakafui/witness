/// <reference lib="dom" />
// The live page. It keeps its own copy of the graph in Relate (WASM), built by the same statements the hub runs,
// and answers every panel and query with Cypher in the page. The hub sends new records, states and results.
//
// The lanes show how the agents got here: one row per direction of work, questions in the order they were asked.
// The rule check shows why an answer stands: each part of the rule, the measurements it names, and whether it held.
// DESIGN.md gives the tokens and the reasons.
import init, { RelateDb } from "@relate/relate-wasm";
import wasmUrl from "@relate/relate-wasm/relate_bg.wasm" with { type: "file" };
import { animate } from "motion";
import { answerParams, clauses, type GNode, type GRel, measurements, named, type State, type Status, statements } from "../src/graph.ts";
import { type Navigation, register, webTools } from "./tools.ts";

type Msg =
  | { type: "replay"; step: number; of: number }
  | { type: "graph"; nodes: GNode[]; rels: GRel[] }
  | { type: "states"; states: Status[] }
  | { type: "result"; question: string; run: string; data: unknown };

type QNode = { id: string; text: string; asker: string | null; seq: number };
type QLink = { source: string; target: string; type: "NEEDS" | "DISPUTES" };
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
const live = new Map<string, unknown[]>(); // run -> results printed so far
let selected: string | null = null;
let marked = new Set<string>();
let focus: { nodes: Set<string>; links: Set<string> } | null = null;
let walkthrough: AbortController | null = null;
let activeTween: ReturnType<typeof animate> | null = null;
let tourPlaying = false;
let tourIndex = -1;
let tourTransition = false;
let tourPauseAnimation = false;
let tourReady = false;
let tourGeneration = 0;
let tourTimer: ReturnType<typeof setTimeout> | undefined;
let tourDeadline = 0;
let tourRemaining = 5000;
let tourPreview: number | null = null;
let replayComplete = true; // Live workspaces have no replay stream to wait for.
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const linkId = (l: QLink) => `${l.source}:${l.type}:${l.target}`;
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
const names = h("div", { class: "lane-names", "aria-hidden": "true" });
const scroller = h("div", { class: "lanes" });
const svg = s("svg", { role: "group", "aria-label": "Questions by direction of work, in the order they were asked" }) as SVGSVGElement;
const legend = (kind: string, words: string) => h("span", {}, s("svg", { width: 22, height: 6, "aria-hidden": "true" }, s("line", { class: `link ${kind}`, x1: 0, x2: 22, y1: 3, y2: 3 })), words);
scroller.append(svg, h("p", { class: "caption" }, legend("needs", "reads a file from"), legend("disputes", "disputes")));
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
  const refuted = new Set(params().refuted);
  place.clear();
  questions.forEach((q, i) => place.set(q.id, { x: PAD + i * col, y: TOP + lane * (lanes.indexOf(laneOf(q.asker)) + 0.5) }));

  names.replaceChildren(...lanes.map((name) => h("div", { title: name }, name)));
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const rails = lanes.map((_, i) => s("line", { class: "rail", x1: 0, x2: width, y1: TOP + lane * (i + 0.5), y2: TOP + lane * (i + 0.5) }));
  const paths = links.flatMap((l) => {
    // Evidence flows forward: from the question that saved a file to the one that read it, from a dispute to the question it disputes.
    const [from, to] = l.type === "NEEDS" ? [place.get(l.target), place.get(l.source)] : [place.get(l.source), place.get(l.target)];
    if (!from || !to) return [];
    const lit = focus?.links.has(linkId(l));
    return [
      s("path", {
        d: curve(from, to, l.type === "DISPUTES" ? 1 : -1, lane),
        class: `link ${l.type.toLowerCase()}${focus ? (lit ? " lit" : " dim") : ""}`,
        ...(lit ? { pathLength: 1 } : {}),
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
    if (state === "running" && !reducedMotion()) g.append(s("circle", { class: "pulse", r: 9 }));
    g.append(glyph(state, 9));
    if (refuted.has(q.id)) g.append(s("circle", { class: "ring refuted", r: 17 }));
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

/** A link between two questions. In one lane it arcs, above for a file and below for a dispute, so it clears the questions between. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, side: 1 | -1, lane: number) {
  if (a.y === b.y) {
    const lift = Math.min(lane * 0.42, 10 + Math.abs(b.x - a.x) * 0.18);
    return `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${a.y + side * lift * 2} ${b.x} ${b.y}`;
  }
  const dx = Math.max(24, (b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** How far a walkthrough has drawn its paths and dimmed the rest: 0 to 1. */
const progress = (p: number) => svg.style.setProperty("--p", String(p));

new ResizeObserver(() => render()).observe(el);

function setSidebar(open: boolean, interrupt = true) {
  if (interrupt) stopWalkthrough();
  if (!open && sidebar.contains(document.activeElement)) sidebarToggle.focus();
  main.classList.toggle("sidebar-collapsed", !open);
  sidebar.inert = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
  sidebarToggle.setAttribute("aria-expanded", String(open));
  sidebarToggle.textContent = open ? "Hide evidence" : "Show evidence";
}
sidebarToggle.onclick = () => setSidebar(sidebarToggle.getAttribute("aria-expanded") !== "true");
// Direct manipulation always wins over a guided walkthrough.
scroller.addEventListener("pointerdown", () => stopWalkthrough());
scroller.addEventListener("wheel", () => stopWalkthrough(), { passive: true });

function stopWalkthrough(interruptTour = true) {
  if (interruptTour) pauseTour();
  if (!walkthrough) return;
  walkthrough.abort();
  walkthrough = null;
  main.classList.remove("walking");
  document.getElementById("question")!.style.removeProperty("opacity");
  progress(1);
  main.dataset.walkthroughStage = "cancelled";
  document.getElementById("walkthrough-status")!.textContent = "";
}

/** A Motion tween that also resolves when interrupted, so WebMCP calls never hang on cancellation. */
async function tween(duration: number, update: (progress: number) => void, signal: AbortSignal) {
  if (signal.aborted) return false;
  if (reducedMotion()) {
    update(1);
    return true;
  }
  const motion = animate(0, 1, { duration, ease: "easeInOut", onUpdate: (p) => { if (!signal.aborted) update(p); } });
  activeTween = motion;
  if (tourPauseAnimation) motion.pause();
  return new Promise<boolean>((resolve) => {
    const clear = () => { if (activeTween === motion) activeTween = null; };
    const cancel = () => { motion.stop(); clear(); resolve(false); };
    signal.addEventListener("abort", cancel, { once: true });
    void motion.then(() => { clear(); signal.removeEventListener("abort", cancel); resolve(true); });
  });
}

function stage(name: string, label: string) {
  main.dataset.walkthroughStage = name;
  document.getElementById("walkthrough-status")!.textContent = label;
}

/** The scroll position that puts these questions in the middle of the lanes. */
function centre(ids: Set<string>) {
  const xs = [...ids].flatMap((q) => place.get(q)?.x ?? []);
  if (!xs.length) return scroller.scrollLeft;
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  return Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, mid - scroller.clientWidth / 2));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function navigate({ id: start = selected ?? undefined, relation, depth = 1 }: Navigation, fromTour = false) {
  if (!fromTour) {
    pauseTour();
    tourPauseAnimation = false;
  }
  if (relation === "overview") {
    stopWalkthrough(false);
    focus = null;
    marked.clear();
    progress(1);
    document.getElementById("navigation")!.hidden = true;
    render();
    scroller.scrollTo({ left: 0, behavior: reducedMotion() ? "auto" : "smooth" });
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
      const targets =
        relation === "disputes"
          ? l.type === "DISPUTES" ? [frontier.has(from) ? to : null, frontier.has(to) ? from : null] : []
          : l.type === "NEEDS" ? [relation === "dependencies" ? (frontier.has(from) ? to : null) : frontier.has(to) ? from : null] : [];
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
  stopWalkthrough(false);
  const controller = new AbortController();
  walkthrough = controller;
  const { signal } = controller;
  main.classList.add("walking");
  selected = start;
  marked.clear();
  focus = { nodes: found, links: new Set(followed.keys()) };
  progress(0);
  render();
  document.getElementById("navigation")!.hidden = false;
  document.getElementById("navigation-summary")!.textContent =
    `${relation[0]!.toUpperCase() + relation.slice(1)}: ${plural(found.size, "question")}, ${plural(followed.size, "link")}, depth ${depth}`;

  stage("camera", "");
  const from = scroller.scrollLeft;
  const to = centre(found);
  if (!(await tween(0.6, (p) => { scroller.scrollLeft = from + (to - from) * p; }, signal))) return { id: start, cancelled: true };
  stage("paths", "");
  if (!(await tween(0.6, progress, signal))) return { id: start, cancelled: true };
  stage("evidence", "");
  const panel = document.getElementById("question")!;
  tab("question", false);
  showQuestion(start);
  panel.scrollTop = 0;
  setSidebar(true, false);
  if (!(await tween(0.3, (p) => { panel.style.opacity = String(p); }, signal))) return { id: start, cancelled: true };
  panel.style.removeProperty("opacity");
  walkthrough = null;
  main.classList.remove("walking");
  stage("complete", "");
  return {
    id: start,
    relation,
    depth,
    questions: [...found].map((qid) => ({ id: qid, text: nodes.get(qid)!.text, answer: stateOf(qid) })),
    links: [...followed.values()].map((l) => ({ from: l.source, to: l.target, type: l.type })),
  };
}
document.getElementById("overview")!.onclick = () => navigate({ relation: "overview" });

// ---------------------------------------------------------------------------------------------------------------
// The tour visits every question in asking order, including negative answers and failed measurements.

const tourPlay = document.getElementById("tour-play") as HTMLButtonElement;
const tourPrevious = document.getElementById("tour-previous") as HTMLButtonElement;
const tourNext = document.getElementById("tour-next") as HTMLButtonElement;
const tourSeek = document.getElementById("tour-seek") as HTMLInputElement;
const tourQuestions = () => [...nodes.values()].sort((a, b) => a.seq - b.seq);

function updateTour() {
  const questions = tourQuestions();
  const position = tourPreview ?? tourIndex;
  const current = questions[position];
  const finished = tourReady && replayComplete && tourIndex === questions.length - 1;
  const where = `${position + 1} of ${questions.length}${replayComplete ? "" : " so far"}`;
  document.getElementById("tour-progress")!.textContent = !questions.length
    ? "No questions yet"
    : !current
      ? `${plural(questions.length, "question")}${replayComplete ? "" : " so far"}`
      : tourPreview !== null
        ? `Go to ${where}`
        : tourPlaying
          ? `Playing ${where}`
          : finished
            ? `Finished ${where}`
            : `Paused at ${where}`;
  document.getElementById("tour-title")!.textContent = current?.text ?? "";
  tourPlay.disabled = !questions.length;
  tourPlay.textContent = tourPlaying ? "Pause" : finished ? "Replay" : "Play";
  tourPlay.setAttribute("aria-label", `${tourPlay.textContent} investigation`);
  tourPrevious.disabled = tourIndex <= 0;
  tourNext.disabled = tourIndex >= questions.length - 1;
  tourSeek.disabled = !questions.length;
  tourSeek.max = String(Math.max(0, questions.length - 1));
  tourSeek.value = String(Math.max(0, position));
  tourSeek.setAttribute("aria-valuetext", current ? `Question ${position + 1} of ${questions.length}: ${current.text}` : "No questions yet");
}

function pauseTour() {
  if (!tourPlaying) return;
  tourPlaying = false;
  if (tourTimer !== undefined) tourRemaining = Math.max(0, tourDeadline - performance.now());
  clearTimeout(tourTimer);
  tourTimer = undefined;
  if (tourTransition) {
    tourPauseAnimation = true;
    activeTween?.pause();
  }
  updateTour();
}

/** Give the viewer five seconds with each completed result before moving on. */
function continueTour() {
  updateTour();
  if (!tourPlaying || tourTransition || !tourReady || tourTimer !== undefined) return;
  const questions = tourQuestions();
  const current = questions[tourIndex];
  if (!current || !["yes", "no", "failed"].includes(stateOf(current.id))) return;
  if (tourIndex === questions.length - 1) {
    if (replayComplete) {
      tourPlaying = false;
      updateTour();
    }
    return; // More questions may still arrive from the recorded session or a live workspace.
  }
  tourDeadline = performance.now() + tourRemaining;
  tourTimer = setTimeout(() => {
    tourTimer = undefined;
    void visitTour(tourIndex + 1);
  }, tourRemaining);
}

async function visitTour(index: number) {
  const question = tourQuestions()[index];
  if (!question) return;
  const generation = ++tourGeneration;
  clearTimeout(tourTimer);
  tourTimer = undefined;
  tourIndex = index;
  tourPreview = null;
  tourTransition = true;
  tourReady = false;
  tourPauseAnimation = false;
  tourRemaining = 5000;
  updateTour();
  const relation = links.some((l) => l.type === "DISPUTES" && l.source === question.id) ? "disputes" : "dependencies";
  const result = await navigate({ id: question.id, relation, depth: 1 }, true);
  if (generation !== tourGeneration) return;
  tourTransition = false;
  tourPauseAnimation = false;
  tourReady = !("cancelled" in result);
  continueTour();
}

tourPlay.onclick = () => {
  if (tourPlaying) {
    pauseTour();
    return;
  }
  tourPlaying = true;
  if (tourTransition) {
    tourPauseAnimation = false;
    activeTween?.play();
    updateTour();
    return;
  }
  if (tourIndex < 0 || (tourReady && replayComplete && tourIndex === nodes.size - 1)) void visitTour(0);
  else if (!tourReady) void visitTour(tourIndex);
  else continueTour();
};
tourPrevious.onclick = () => void visitTour(tourIndex - 1);
tourNext.onclick = () => void visitTour(tourIndex + 1);
tourSeek.oninput = () => {
  pauseTour();
  stopWalkthrough(false);
  tourPreview = Number(tourSeek.value);
  updateTour();
};
tourSeek.onchange = () => void visitTour(Number(tourSeek.value));

// ---------------------------------------------------------------------------------------------------------------
// Messages from the hub

function apply(m: Msg) {
  if (m.type === "replay") {
    replayComplete = m.step === m.of;
    const link = document.getElementById("link")!;
    link.textContent = m.step < m.of ? `Replaying ${m.step} of ${m.of}` : "Replay finished";
    link.className = "on";
    continueTour();
    return;
  }
  if (m.type === "graph") {
    for (const st of statements(m.nodes, m.rels)) cypher(st.cypher, st.params);
    for (const n of m.nodes)
      if (n.label === "Question" && !nodes.has(n.id))
        nodes.set(n.id, { id: n.id, text: String(n.props.text), asker: (n.props.asker as string) ?? null, seq: Number(n.props.seq) });
    for (const r of m.rels)
      if ((r.type === "NEEDS" || r.type === "DISPUTES") && !links.some((l) => l.source === r.from && l.target === r.to && l.type === r.type))
        links.push({ source: r.from, target: r.to, type: r.type });
  } else if (m.type === "states") {
    statuses = new Map(m.states.map((x) => [x.id, x]));
  } else if (m.type === "result") {
    live.set(m.run, [...(live.get(m.run) ?? []), m.data]);
  }
  if (m.type !== "result") {
    render();
    counts();
  }
  if (selected && (m.type !== "result" || m.question === selected)) showQuestion(selected);
  continueTour();
}

function connect(delay = 500) {
  const link = document.getElementById("link")!;
  const ws = new WebSocket(new URL("/events", location.href.replace(/^http/, "ws")));
  ws.onopen = () => ((link.textContent = "Live"), (link.className = "on"));
  ws.onmessage = (e) => apply(JSON.parse(e.data));
  ws.onclose = () => {
    link.textContent = "Reconnecting";
    link.className = "off";
    setTimeout(() => connect(Math.min(delay * 2, 8000)), delay);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The header: answers by kind, then how much doubt the record has survived.

function counts() {
  const all = [...statuses.values()];
  const disputed = new Set(links.filter((l) => l.type === "DISPUTES").map((l) => l.target));
  const refuted = params().refuted.length;
  const box = document.getElementById("counts")!;
  if (!all.length) return box.replaceChildren();
  box.replaceChildren(
    ...(["yes", "no", "failed", "running", "pending", "waiting"] as State[])
      .map((st) => [st, all.filter((x) => x.state === st).length] as const)
      .filter(([, n]) => n)
      .map(([st, n]) => h("span", { class: "count" }, mark(st), h("b", {}, String(n)), ` ${st}`)),
    h(
      "span",
      { class: `doubt${disputed.size ? "" : " none"}` },
      disputed.size ? `${disputed.size} disputed, ${refuted ? `${refuted} refuted` : "none refuted"}` : "No disputes",
    ),
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
     OPTIONAL MATCH (m:Question)-[:NEEDS]->(q) WITH q, needs, collect(DISTINCT m.id) AS neededBy
     OPTIONAL MATCH (q)-[:DISPUTES]->(d:Question) WITH q, needs, neededBy, collect(DISTINCT d.id) AS disputes
     OPTIONAL MATCH (e:Question)-[:DISPUTES]->(q)
     RETURN needs, neededBy, disputes, collect(DISTINCT e.id) AS disputedBy`,
    { selected: qid },
  );
  const runs = cypher(
    `MATCH (r:Run)-[:OF]->(:Question {id: $selected})
     RETURN r.id AS run, r.seq AS seq, r.answer AS answer, r.reason AS reason, r.results AS results, r.packages AS packages ORDER BY r.seq DESC`,
    { selected: qid },
  );
  // A run is written when it ends. While one runs, the panel shows what it has printed so far.
  const running = st?.state === "running" ? st.run : null;
  const shown = running ? null : (runs.find((r) => r.run === st?.run) ?? runs[0]);
  const results: unknown[] = running ? (live.get(running) ?? []) : shown ? JSON.parse(String(shown.results)) : [];
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
    refuted: params().refuted.includes(qid),
    restsOn: ids(l?.needs),
    usedBy: ids(l?.neededBy),
    disputes: ids(l?.disputes),
    disputedBy: ids(l?.disputedBy),
    final: !running && Boolean(shown),
    results,
    saved: saved.map((f) => ({ name: String(f.name), url: `/files/${f.file}?name=${encodeURIComponent(String(f.name))}` })),
    packages: ids(shown?.packages),
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
    ruleCheck(d.rule, d.results, d.final || d.results.length > 0),
    d.refuted ? h("p", { class: "reason refuted" }, "Refuted by a dispute.") : null,
    reason ? h("p", { class: "reason" }, reason) : null,
    ...(pictures.length
      ? [h("h3", {}, "Images"), ...pictures.map((f) => h("figure", {}, h("img", { src: f.url, alt: f.name }), h("figcaption", {}, h("a", { href: f.url, target: "_blank" }, f.name))))]
      : []),
    ...list("Reads files from", d.restsOn),
    ...list("Gives files to", d.usedBy),
    ...list("Disputes", d.disputes),
    ...list("Disputed by", d.disputedBy),
    ...(files.length ? [h("h3", {}, "Files"), h("ul", {}, ...files.map((f) => h("li", {}, h("a", { href: f.url, target: "_blank" }, f.name))))] : []),
    ...(d.inputs.length ? [h("h3", {}, "Inputs"), h("ul", {}, ...d.inputs.map((i) => h("li", { class: "id" }, i)))] : []),
    d.results.length ? h("h3", {}, d.final ? "Measurements" : "Measurements so far") : null,
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
    d.packages.length ? h("h3", {}, "Packages") : null,
    d.packages.length ? h("p", { class: "id hint" }, d.packages.join("  ")) : null,
    h("details", {}, h("summary", {}, "Probe"), h("pre", {}, d.probe)),
  ];
  document.getElementById("question")!.replaceChildren(...parts.filter((x) => x !== null));
}

function select(qid: string) {
  stopWalkthrough();
  focus = null;
  progress(1);
  document.getElementById("navigation")!.hidden = true;
  selected = qid;
  tab("question");
  showQuestion(qid);
  render();
  const x = place.get(qid)?.x;
  if (x !== undefined && (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth)) scroller.scrollLeft = x - scroller.clientWidth / 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

const PRESETS: [string, string][] = [
  ["What does the selected question use?", "MATCH (q:Question {id: $selected})-[:NEEDS*0..]->(u:Question)\nRETURN DISTINCT u.id AS id, u.text AS text, u.seq AS seq ORDER BY seq"],
  ["Which yes answers are not refuted?", "MATCH (q:Question)\nWHERE q.id IN $yes AND NOT q.id IN $refuted\nOPTIONAL MATCH (d:Question)-[:DISPUTES]->(q)\nRETURN q.id AS id, q.text AS text, count(d) AS disputes ORDER BY disputes DESC, q.seq"],
  ["Which answers are refuted?", "MATCH (d:Question)-[:DISPUTES]->(c:Question)\nWHERE d.id IN $yes\nRETURN c.id AS claim, c.text AS text, d.id AS refuted_by ORDER BY d.seq"],
  ["What did each dispute answer?", "MATCH (d:Question)-[:DISPUTES]->(c:Question)\nRETURN c.id AS question, d.id AS dispute, d.id IN $yes AS refutes, d.text AS text ORDER BY d.seq"],
  ["What is each rule?", "MATCH (q:Question)\nRETURN q.id AS id, q.rule AS rule, q.id IN $yes AS yes ORDER BY q.seq"],
  ["Which questions read each file?", "MATCH (q:Question)<-[:OF]-(r:Run)-[x:READ]->(:File)\nWHERE r.id IN $current AND NOT x.name STARTS WITH 'q-'\nRETURN x.name AS input, count(DISTINCT q) AS read_by, collect(DISTINCT q.id) AS questions ORDER BY input"],
  ["Which questions read from the same question?", "MATCH (a:Question)-[:NEEDS]->(u:Question)<-[:NEEDS]-(b:Question)\nWHERE a.seq < b.seq\nRETURN u.id AS output_of, a.id AS a, b.id AS b"],
  ["Which runs failed, and why?", "MATCH (r:Run {answer: 'failed'})-[:OF]->(q:Question)\nRETURN q.id AS id, r.reason AS reason, r.seq AS seq ORDER BY seq DESC"],
  ["Which packages did the probes use?", "MATCH (r:Run)-[:OF]->(q:Question)\nUNWIND r.packages AS p\nRETURN split(p, '==')[0] AS package, count(DISTINCT q) AS questions, collect(DISTINCT split(p, '==')[1]) AS versions\nORDER BY questions DESC, package"],
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
  ...answerParams([...statuses.values()], links.filter((l) => l.type === "DISPUTES").map((l) => [l.source, l.target] as [string, string])),
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
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const sec of document.querySelectorAll<HTMLElement>("aside section")) sec.hidden = sec.id !== name;
}
for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) b.onclick = () => tab(b.dataset.tab!);

render();
updateTour();
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
