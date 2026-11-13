/// <reference lib="dom" />
// The live page. It keeps its own copy of the graph in Relate (WASM), built by the same statements the hub runs,
// and answers every panel and query with Cypher in the page. The hub sends new records, states and results.
import init, { RelateDb } from "@relate/relate-wasm";
import wasmUrl from "@relate/relate-wasm/relate_bg.wasm" with { type: "file" };
import ForceGraph from "force-graph";
import { animate } from "motion";
import { answerParams, type GNode, type GRel, type State, type Status, statements } from "../src/graph.ts";
import { type Navigation, register, webTools } from "./tools.ts";

type Msg =
  | { type: "replay"; step: number; of: number }
  | { type: "graph"; nodes: GNode[]; rels: GRel[] }
  | { type: "states"; states: Status[] }
  | { type: "result"; question: string; run: string; data: unknown };

type QNode = { id: string; text: string; asker: string | null; seq: number; x?: number; y?: number };
type QLink = { source: string | QNode; target: string | QNode; type: "NEEDS" | "DISPUTES" };
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
let focusProgress = 1;
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
let tourHideTimer: ReturnType<typeof setTimeout> | undefined;
let replayComplete = true; // Live workspaces have no replay stream to wait for.
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const linkId = (l: QLink) => `${id(l.source)}:${l.type}:${id(l.target)}`;

const color = (s: State | undefined) => getComputedStyle(document.documentElement).getPropertyValue(`--${s === "pending" ? "running" : (s ?? "waiting")}`).trim();
const hollow = (s: State | undefined) => s === "pending" || s === "waiting" || s === undefined;

// ---------------------------------------------------------------------------------------------------------------
// The graph view

const el = document.getElementById("graph")!;
const graph = new ForceGraph<QNode, QLink>(el)
  .nodeId("id")
  .graphData({ nodes: [], links: [] })
  .autoPauseRedraw(false)
  .linkColor((l) => (l.type === "DISPUTES" ? color("no") : getComputedStyle(document.documentElement).getPropertyValue("--line").trim()) + (focus ? Math.round(255 * (1 - 0.75 * focusProgress)).toString(16).padStart(2, "0") : ""))
  .linkWidth((l) => l.type === "DISPUTES" ? 1.5 : 1.2)
  .linkCanvasObjectMode(() => "after")
  .linkCanvasObject((l, ctx) => {
    if (!focus?.links.has(linkId(l)) || typeof l.source === "string" || typeof l.target === "string") return;
    const index = [...focus.links].indexOf(linkId(l));
    const progress = Math.max(0, Math.min(1, focusProgress * focus.links.size - index));
    if (!progress) return;
    const x = l.source.x ?? 0, y = l.source.y ?? 0;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + ((l.target.x ?? 0) - x) * progress, y + ((l.target.y ?? 0) - y) * progress);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    ctx.lineWidth = 2.5;
    if (l.type === "DISPUTES") ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();
  })
  .linkLineDash((l) => (l.type === "DISPUTES" ? [4, 3] : null))
  .linkDirectionalArrowLength(5)
  .linkDirectionalArrowRelPos(1)
  .nodeRelSize(7)
  .nodeLabel((n) => n.text)
  .onNodeClick((n) => select(n.id))
  .nodeCanvasObject((n, ctx, scale) => {
    ctx.save();
    if (focus && !focus.nodes.has(n.id)) ctx.globalAlpha = 1 - 0.85 * focusProgress;
    const s = statuses.get(n.id)?.state;
    const r = 7;
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    if (s === "running") {
      const t = (performance.now() % 1400) / 1400;
      ctx.beginPath();
      ctx.arc(x, y, r + 2 + t * 8, 0, 2 * Math.PI);
      ctx.strokeStyle = color("running");
      ctx.globalAlpha *= 1 - t;
      ctx.lineWidth = 2 / scale;
      ctx.stroke();
      ctx.globalAlpha = focus && !focus.nodes.has(n.id) ? 1 - 0.85 * focusProgress : 1;
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
    if (n.id === selected || marked.has(n.id) || (focusProgress > 0 && focus?.nodes.has(n.id))) {
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
      ctx.lineWidth = n.id === selected ? 3 : 2;
      ctx.stroke();
    }
    if (scale > 0.9 || focus?.nodes.has(n.id)) {
      const label = n.text.length > 48 ? `${n.text.slice(0, 46)}…` : n.text;
      ctx.font = `${11 / Math.min(scale, 2)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted");
      ctx.fillText(label, x, y + r + 4);
    }
    ctx.restore();
  });

graph.cooldownTime(2500);
graph.d3Force("charge")?.strength(-260).distanceMax(320);
graph.d3Force("link")?.distance(90);
// Fit the view once the layout settles after new questions arrive; leave the viewer's zoom alone otherwise.
let fitted = 0;
graph.onEngineStop(() => {
  if (walkthrough) return;
  if (focus) fitFocus();
  else if (nodes.size !== fitted) graph.zoomToFit(500, 100);
  fitted = nodes.size;
});
new ResizeObserver(() => graph.width(el.clientWidth).height(el.clientHeight)).observe(el);

const main = document.querySelector("main")!;
const sidebar = document.getElementById("sidebar")!;
const sidebarToggle = document.getElementById("sidebar-toggle")!;
function setSidebar(open: boolean, interrupt = true) {
  if (interrupt) stopWalkthrough();
  if (!open && sidebar.contains(document.activeElement)) sidebarToggle.focus();
  main.classList.toggle("sidebar-collapsed", !open);
  sidebar.inert = !open;
  sidebar.setAttribute("aria-hidden", String(!open));
  sidebarToggle.setAttribute("aria-expanded", String(open));
  sidebarToggle.textContent = open ? "Hide sidebar" : "Show sidebar";
  // With reduced motion there is no transitionend to reframe the evidence.
  if (interrupt && reducedMotion()) requestAnimationFrame(() => { if (focus) fitFocus(); });
}
sidebarToggle.onclick = () => setSidebar(sidebarToggle.getAttribute("aria-expanded") !== "true");
main.addEventListener("transitionend", (e) => {
  if (e.target === main && e.propertyName === "grid-template-columns" && focus && !walkthrough) fitFocus();
});
// Direct manipulation always wins over a guided camera move.
el.addEventListener("pointerdown", () => stopWalkthrough());
el.addEventListener("wheel", () => stopWalkthrough(), { passive: true });

function stopWalkthrough(interruptTour = true) {
  if (interruptTour) pauseTour();
  if (!walkthrough) return;
  walkthrough.abort();
  walkthrough = null;
  main.classList.remove("walking");
  main.style.removeProperty("grid-template-columns");
  sidebar.style.removeProperty("opacity");
  focusProgress = 1;
  main.dataset.walkthroughStage = "cancelled";
  document.getElementById("walkthrough-status")!.textContent = "Walkthrough stopped";
}

/** A Motion tween that also resolves when interrupted, so WebMCP calls never hang on cancellation. */
async function tween(duration: number, update: (progress: number) => void, signal: AbortSignal) {
  if (signal.aborted) return false;
  if (reducedMotion()) { update(1); return true; }
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

function redraw() {
  graph.graphData({ nodes: [...nodes.values()], links: [...links] });
}

/** Fit the chosen evidence, with room for its labels. Other questions stay visible for context. */
function focusPose(width = graph.width()) {
  const chosen = [...nodes.values()].filter((n) => focus?.nodes.has(n.id));
  if (!chosen.length) return null;
  const xs = chosen.map((n) => n.x ?? 0), ys = chosen.map((n) => n.y ?? 0);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const zoom = Math.max(0.08, Math.min(1.8, Math.max(80, width - 280) / Math.max(1, x1 - x0), Math.max(80, graph.height() - 180) / Math.max(1, y1 - y0)));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom };
}

function fitFocus() {
  const pose = focusPose();
  if (pose) graph.centerAt(pose.x, pose.y, reducedMotion() ? 0 : 700).zoom(pose.zoom, reducedMotion() ? 0 : 700);
}

async function navigate({ id: start = selected ?? undefined, relation, depth = 1 }: Navigation, fromTour = false) {
  if (!fromTour) { pauseTour(); tourPauseAnimation = false; }
  if (relation === "overview") {
    stopWalkthrough(false);
    focus = null;
    marked.clear();
    document.getElementById("navigation")!.hidden = true;
    graph.zoomToFit(reducedMotion() ? 0 : 700, 100);
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
      const from = id(l.source), to = id(l.target);
      const targets = relation === "disputes"
        ? l.type === "DISPUTES" ? [frontier.has(from) ? to : null, frontier.has(to) ? from : null] : []
        : l.type === "NEEDS" ? [relation === "dependencies" ? frontier.has(from) ? to : null : frontier.has(to) ? from : null] : [];
      for (const target of targets) if (target) {
        followed.set(linkId(l), l);
        if (!found.has(target)) { found.add(target); next.add(target); }
      }
    }
    frontier = next;
  }
  stopWalkthrough(false);
  const controller = new AbortController();
  walkthrough = controller;
  const { signal } = controller;
  // Stop ForceGraph's own camera tween before Motion takes control.
  const before = { ...graph.centerAt(), zoom: graph.zoom() };
  graph.centerAt(before.x, before.y, 0).zoom(before.zoom, 0);
  main.classList.add("walking");
  setSidebar(false, false);
  graph.width(el.clientWidth).height(el.clientHeight);
  selected = start;
  marked.clear();
  focus = { nodes: found, links: new Set(followed.keys()) };
  focusProgress = 0;
  document.getElementById("navigation")!.hidden = false;
  document.getElementById("navigation-summary")!.textContent = `${relation[0]!.toUpperCase() + relation.slice(1)} · ${found.size} question${found.size === 1 ? "" : "s"} · ${followed.size} link${followed.size === 1 ? "" : "s"} · depth ${depth}`;
  const fullWidth = main.clientWidth;
  const panelWidth = Math.min(420, Math.max(0, fullWidth - 280));
  const finalWidth = fullWidth - panelWidth;
  stage("camera", "1 / 3 · Moving to the evidence");
  if (!await tween(1.1, (p) => {
    const pose = focusPose(finalWidth)!;
    // Reserve the future panel's space, keeping the evidence still when the panel enters.
    const x = pose.x + panelWidth / (2 * pose.zoom);
    graph.centerAt(before.x + (x - before.x) * p, before.y + (pose.y - before.y) * p, 0).zoom(before.zoom + (pose.zoom - before.zoom) * p, 0);
  }, signal)) return { id: start, cancelled: true };
  stage("paths", "2 / 3 · Following the evidence paths");
  if (!await tween(0.9, (p) => { focusProgress = p; }, signal)) return { id: start, cancelled: true };
  // Prepare the panel while it is hidden. Only this sequence may open it now.
  tab("question", false);
  showQuestion(start);
  main.style.gridTemplateColumns = "minmax(0, 1fr) 0px";
  setSidebar(true, false);
  stage("evidence", "3 / 3 · Opening the evidence");
  if (!await tween(0.65, (p) => {
    const width = panelWidth * p;
    main.style.gridTemplateColumns = `minmax(0, 1fr) ${width}px`;
    sidebar.style.opacity = String(p);
    graph.width(fullWidth - width);
    const pose = focusPose(finalWidth)!;
    graph.centerAt(pose.x + (panelWidth - width) / (2 * pose.zoom), pose.y, 0).zoom(pose.zoom, 0);
  }, signal)) return { id: start, cancelled: true };
  walkthrough = null;
  main.classList.remove("walking");
  main.style.removeProperty("grid-template-columns");
  sidebar.style.removeProperty("opacity");
  stage("complete", "Evidence ready");
  return {
    id: start, relation, depth,
    questions: [...found].map((qid) => ({ id: qid, text: nodes.get(qid)!.text, answer: statuses.get(qid)?.state ?? "waiting" })),
    links: [...followed.values()].map((l) => ({ from: id(l.source), to: id(l.target), type: l.type })),
  };
}
document.getElementById("overview")!.onclick = () => navigate({ relation: "overview" });

// The tour visits every question in asking order, including negative answers and failed measurements.
const tourPlay = document.getElementById("tour-play") as HTMLButtonElement;
const tourPrevious = document.getElementById("tour-previous") as HTMLButtonElement;
const tourNext = document.getElementById("tour-next") as HTMLButtonElement;
const tourSeek = document.getElementById("tour-seek") as HTMLInputElement;
const tourDock = document.getElementById("tour")!;
const tourPeek = document.getElementById("tour-peek") as HTMLButtonElement;
const tourQuestions = () => [...nodes.values()].sort((a, b) => a.seq - b.seq);

function revealTourControls() {
  clearTimeout(tourHideTimer);
  tourHideTimer = undefined;
  tourDock.classList.remove("auto-hidden");
  tourDock.inert = false;
  tourPeek.hidden = true;
  if (tourPlaying) armTourHide();
}

function armTourHide() {
  if (tourHideTimer !== undefined || tourDock.classList.contains("auto-hidden")) return;
  tourHideTimer = setTimeout(() => {
    tourHideTimer = undefined;
    if (!tourPlaying) return;
    if (tourDock.matches(":hover") || tourDock.querySelector(":focus-visible")) { armTourHide(); return; }
    if (tourDock.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    tourDock.classList.add("auto-hidden");
    tourDock.inert = true;
    tourPeek.hidden = false;
  }, 2500);
}
main.addEventListener("pointermove", revealTourControls);
tourDock.addEventListener("focusin", revealTourControls);
tourPeek.onclick = () => { revealTourControls(); tourPlay.focus(); };

function updateTour() {
  const questions = tourQuestions();
  const position = tourPreview ?? tourIndex;
  const current = questions[position];
  const finished = tourReady && replayComplete && tourIndex === questions.length - 1;
  document.getElementById("tour-progress")!.textContent = current
    ? `${tourPreview !== null ? "Seek" : tourPlaying ? "Playing" : finished ? "Finished" : "Paused"} · ${position + 1} / ${questions.length}${replayComplete ? "" : " so far"}`
    : "Ready to explore";
  document.getElementById("tour-title")!.textContent = current?.text ?? "Walk through the investigation, one question at a time.";
  tourPlay.disabled = !questions.length;
  tourPlay.textContent = tourPlaying ? "Pause" : finished ? "Replay" : "Play";
  tourPlay.setAttribute("aria-label", `${tourPlaying ? "Pause" : finished ? "Replay" : "Play"} investigation`);
  tourPrevious.disabled = tourIndex <= 0;
  tourNext.disabled = tourIndex >= questions.length - 1;
  tourSeek.disabled = !questions.length;
  tourSeek.max = String(Math.max(0, questions.length - 1));
  tourSeek.value = String(Math.max(0, position));
  tourSeek.setAttribute("aria-valuetext", current ? `Question ${position + 1} of ${questions.length}: ${current.text}` : "No questions yet");
  document.getElementById("tour-marks")!.replaceChildren(...questions.map((q, i) => h("span", { class: i === position ? "current" : "", style: `--c: var(--${statuses.get(q.id)?.state === "pending" ? "running" : statuses.get(q.id)?.state ?? "waiting"})` })));
  tourPeek.textContent = `Playing · ${tourIndex + 1} / ${questions.length} · Show controls`;
  if (tourPlaying) armTourHide();
  else revealTourControls();
}

function pauseTour() {
  if (!tourPlaying) return;
  tourPlaying = false;
  if (tourTimer !== undefined) tourRemaining = Math.max(0, tourDeadline - performance.now());
  clearTimeout(tourTimer);
  tourTimer = undefined;
  if (tourTransition) { tourPauseAnimation = true; activeTween?.pause(); }
  updateTour();
}

/** Give the viewer five seconds with each completed result before moving on. */
function continueTour() {
  updateTour();
  if (!tourPlaying || tourTransition || !tourReady || tourTimer !== undefined) return;
  const questions = tourQuestions();
  const current = questions[tourIndex];
  if (!current || !["yes", "no", "failed"].includes(statuses.get(current.id)?.state ?? "")) return;
  if (tourIndex === questions.length - 1) {
    if (replayComplete) { tourPlaying = false; updateTour(); }
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
  const relation = links.some((l) => l.type === "DISPUTES" && id(l.source) === question.id) ? "disputes" : "dependencies";
  const result = await navigate({ id: question.id, relation, depth: 1 }, true);
  if (generation !== tourGeneration) return;
  tourTransition = false;
  tourPauseAnimation = false;
  tourReady = !("cancelled" in result);
  continueTour();
}

tourPlay.onclick = () => {
  if (tourPlaying) { pauseTour(); return; }
  tourPlaying = true;
  if (tourTransition) { tourPauseAnimation = false; activeTween?.play(); updateTour(); return; }
  if (tourIndex < 0 || (tourReady && replayComplete && tourIndex === nodes.size - 1)) void visitTour(0);
  else if (!tourReady) void visitTour(tourIndex);
  else continueTour();
};
tourPrevious.onclick = () => { void visitTour(tourIndex - 1); };
tourNext.onclick = () => { void visitTour(tourIndex + 1); };
tourSeek.oninput = () => {
  const position = Number(tourSeek.value);
  pauseTour();
  stopWalkthrough(false);
  tourPreview = position;
  updateTour();
};
tourSeek.onchange = () => { void visitTour(Number(tourSeek.value)); };

// ---------------------------------------------------------------------------------------------------------------
// Messages from the hub

function apply(m: Msg) {
  if (m.type === "replay") {
    replayComplete = m.step === m.of;
    const link = document.getElementById("link")!;
    link.textContent = m.step < m.of ? `replay ${m.step} of ${m.of}` : "replay: done";
    link.className = "on";
    continueTour();
    return;
  }
  if (m.type === "graph") {
    for (const s of statements(m.nodes, m.rels)) cypher(s.cypher, s.params);
    let changed = false;
    for (const n of m.nodes)
      if (n.label === "Question" && !nodes.has(n.id)) {
        nodes.set(n.id, { id: n.id, text: String(n.props.text), asker: (n.props.asker as string) ?? null, seq: Number(n.props.seq) });
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
  continueTour();
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

function fileLink(name: string, url: string) {
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

/** What the panel shows about a question, and the Cypher behind it. A browser agent gets the same (page/tools.ts). */
function details(qid: string) {
  const used: [string, string][] = [];
  const run = (label: string, query: string, params: Record<string, unknown>) => {
    const text = query.replace(/\n\s+/g, "\n");
    used.push([label, text]);
    return cypher(text, params);
  };
  const [q] = run("The question", "MATCH (q:Question {id: $selected}) RETURN q.text AS text, q.rule AS rule, q.inputs AS inputs, q.asker AS asker", { selected: qid });
  if (!q) return null;
  const s = statuses.get(qid);
  const [l] = run(
    "What it rests on, and what disputes it",
    `MATCH (q:Question {id: $selected})
     OPTIONAL MATCH (q)-[:NEEDS]->(n:Question) WITH q, collect(DISTINCT n.id) AS needs
     OPTIONAL MATCH (m:Question)-[:NEEDS]->(q) WITH q, needs, collect(DISTINCT m.id) AS neededBy
     OPTIONAL MATCH (q)-[:DISPUTES]->(d:Question) WITH q, needs, neededBy, collect(DISTINCT d.id) AS disputes
     OPTIONAL MATCH (e:Question)-[:DISPUTES]->(q)
     RETURN needs, neededBy, disputes, collect(DISTINCT e.id) AS disputedBy`,
    { selected: qid },
  );
  const runs = run(
    "Its runs and their answers",
    `MATCH (r:Run)-[:ANSWERS]->(:Question {id: $selected}) OPTIONAL MATCH (a:Answer)-[:OF]->(r)
     RETURN r.id AS run, r.seq AS seq, a.value AS value, a.reason AS reason, a.results AS results ORDER BY r.seq DESC`,
    { selected: qid },
  );
  const current = s?.run ?? null;
  const shown = runs.find((r) => r.run === current) ?? runs[0];
  const results: unknown[] = shown ? (shown.value ? JSON.parse(String(shown.results)) : (live.get(String(shown.run)) ?? [])) : [];
  const saved = shown ? run("What the run saved", "MATCH (:Run {id: $run})-[s:SAVED]->(f:File) RETURN s.name AS name, f.id AS file ORDER BY name", { run: shown.run }) : [];
  const packages = shown ? run("The packages the run used", "MATCH (:Run {id: $run})-[:USED]->(p:Package) RETURN p.id AS id ORDER BY id", { run: shown.run }) : [];
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    id: qid,
    text: String(q.text),
    rule: String(q.rule),
    inputs: ids(q.inputs),
    asker: (q.asker as string | null) ?? null,
    status: s,
    restsOn: ids(l?.needs),
    usedBy: ids(l?.neededBy),
    disputes: ids(l?.disputes),
    disputedBy: ids(l?.disputedBy),
    final: Boolean(shown?.value),
    results,
    saved: saved.map((f) => ({ name: String(f.name), url: `/files/${f.file}?name=${encodeURIComponent(String(f.name))}` })),
    packages: packages.map((p) => String(p.id)),
    runs: runs.map((r) => ({ run: String(r.run), seq: Number(r.seq), answer: (r.value as string | null) ?? null, reason: (r.reason as string | null) ?? null, current: r.run === current })),
    used,
  };
}

function showQuestion(qid: string) {
  const d = details(qid);
  if (!d) return;
  const s = d.status;
  const list = (title: string, ids: string[]) => (ids.length ? [h("h3", {}, title), h("ul", {}, ...ids.map((x) => h("li", {}, ref(x))))] : []);
  const parts: (HTMLElement | null)[] = [
    h("div", { class: "run" }, badge(s), h("span", { class: "id hint" }, qid), d.asker ? h("span", { class: "hint" }, `asked by ${d.asker}`) : null),
    h("h2", {}, d.text),
    h("p", { class: "rule" }, `Rule: ${d.rule}`),
    s?.reason ? h("p", { class: "error" }, s.reason) : null,
    ...(d.inputs.length ? [h("h3", {}, "Inputs"), h("ul", {}, ...d.inputs.map((i) => h("li", { class: "id" }, i)))] : []),
    ...list("Rests on", d.restsOn),
    ...list("Used by", d.usedBy),
    ...list("Disputes", d.disputes),
    ...list("Disputed by", d.disputedBy),
    d.results.length ? h("h3", {}, d.final ? "Results" : "Results so far") : null,
    d.results.length ? h("pre", {}, d.results.map((x) => JSON.stringify(x)).join("\n")) : null,
    d.saved.length ? h("h3", {}, "Saved") : null,
    d.saved.length ? h("ul", {}, ...d.saved.map((f) => h("li", {}, fileLink(f.name, f.url)))) : null,
    d.packages.length ? h("h3", {}, "Packages") : null,
    d.packages.length ? h("p", { class: "id hint" }, d.packages.join("  ")) : null,
    d.runs.length ? h("h3", {}, "Runs") : null,
    h(
      "ul",
      {},
      ...d.runs.map((r) =>
        h(
          "li",
          { class: "run" },
          h("span", { class: "id hint" }, `#${r.seq}`),
          r.answer ? h("span", { class: "badge", style: `--c: var(--${r.answer})` }, r.answer) : h("span", { class: "hint" }, "running"),
          r.current ? h("span", { class: "hint" }, "current") : null,
          r.reason ? h("span", { class: "reason" }, r.reason.split("\n")[0]!) : null,
        ),
      ),
    ),
    cypherPanel(d.used),
  ];
  document.getElementById("question")!.replaceChildren(...parts.filter((x) => x !== null));
}

/** The Cypher behind the panel, each query ready to run in the Query tab. */
let showCypher = false;
function cypherPanel(used: [string, string][]) {
  const box = h("details", { class: "cypher" }, h("summary", {}, "Cypher behind this panel"));
  (box as HTMLDetailsElement).open = showCypher;
  box.addEventListener("toggle", () => (showCypher = (box as HTMLDetailsElement).open));
  for (const [label, query] of used) {
    const open = h("button", { class: "link" }, "Run in Query tab");
    open.onclick = () => showQuery(query);
    box.append(h("h3", {}, label), h("pre", {}, query), open);
  }
  return box;
}

function select(qid: string) {
  stopWalkthrough();
  focus = null;
  document.getElementById("navigation")!.hidden = true;
  selected = qid;
  tab("question");
  showQuestion(qid);
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

const PRESETS: [string, string][] = [
  ["What does the selected question rest on?", "MATCH (q:Question {id: $selected})-[:NEEDS*0..]->(u:Question)\nRETURN DISTINCT u.id AS id, u.text AS text, u.seq AS seq ORDER BY seq"],
  ["Which yes answers did nothing dispute?", "MATCH (q:Question)\nWHERE q.id IN $yes AND NOT EXISTS { (:Question)-[:DISPUTES]->(q) }\nRETURN q.id AS id, q.text AS text ORDER BY q.seq"],
  ["Which claims were disputed, and did the challenge hold?", "MATCH (d:Question)-[:DISPUTES]->(c:Question)\nRETURN c.id AS claim, d.id AS challenge, d.id IN $yes AS held, d.text AS text ORDER BY d.seq"],
  ["Which questions read each input file?", "MATCH (q:Question)<-[:ANSWERS]-(r:Run)-[x:READ {role: 'input'}]->(:File)\nWHERE r.id IN $current AND NOT x.name STARTS WITH 'q-'\nRETURN x.name AS input, count(DISTINCT q) AS read_by, collect(DISTINCT q.id) AS questions ORDER BY input"],
  ["Which questions build on the same output?", "MATCH (a:Question)-[:NEEDS]->(u:Question)<-[:NEEDS]-(b:Question)\nWHERE a.seq < b.seq\nRETURN u.id AS output_of, a.id AS a, b.id AS b"],
  ["Which runs failed, and why?", "MATCH (a:Answer {value: 'failed'})-[:OF]->(r:Run)-[:ANSWERS]->(q:Question)\nRETURN q.id AS id, a.reason AS reason, r.seq AS seq ORDER BY seq DESC"],
  ["Which packages answered the most questions?", "MATCH (q:Question)<-[:ANSWERS]-(r:Run)-[:USED]->(p:Package)\nRETURN p.name AS package, count(DISTINCT q) AS questions, collect(DISTINCT p.version) AS versions\nORDER BY questions DESC, package"],
  ["Who asked what?", "MATCH (q:Question)\nRETURN q.asker AS asker, count(*) AS questions,\n  sum(CASE WHEN q.id IN $yes THEN 1 ELSE 0 END) AS yes,\n  sum(CASE WHEN q.id IN $no THEN 1 ELSE 0 END) AS no\nORDER BY questions DESC"],
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
const params = () => ({ ...answerParams([...statuses.values()]), selected, run: (selected && statuses.get(selected)?.run) ?? null });

/** Runs the Query tab's Cypher, shows the rows, and marks the questions they name. Returns the rows, or the error. */
function runQuery(): { columns: string[]; rows: Row[] } | Error {
  const out = document.getElementById("rows")!;
  if (text.value.includes("$selected") && !selected) {
    out.replaceChildren(h("p", { class: "hint" }, "Select a question in the graph first: this query uses $selected."));
    return new Error("No question is selected, and this query uses $selected. Select one first.");
  }
  try {
    const r = result(text.value, params());
    marked = new Set(r.rows.flatMap((row) => Object.values(row).flatMap(idsIn)));
    const cell = (v: unknown): Node | string => {
      const ids = idsIn(v);
      if (ids.length && (typeof v === "string" || (Array.isArray(v) && ids.length === v.length)))
        return h("span", { class: "ids" }, ...ids.flatMap((x, i) => (i ? [" ", ref(x)] : [ref(x)])));
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
  for (const s of document.querySelectorAll<HTMLElement>("aside section")) s.hidden = s.id !== name;
}
for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) b.onclick = () => tab(b.dataset.tab!);

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
