/// <reference lib="dom" />
// The live page. It keeps its own copy of the graph in Relate (WASM), built by the same statements the hub runs,
// and answers every panel and query with Cypher in the page. The hub sends new records and states.
//
// The trail shows how the agents got here: one row per question, newest first, with its text, and rails on the left
// for each direction of work and each artifact dependency. Changes lists the runs that changed an answer, an input or
// a measurement. The rule check on the right shows why an answer stands. DESIGN.md gives the tokens.
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
let selectedGoal = "";
let goalInitialized = false;
let marked = new Set<string>();
type Neighborhood = { nodes: Set<string>; links: Set<string> };
type QuestionVisit = { id: string; scroll: number; trail: number; probeOpen: boolean; runsOpen: boolean; marked: Set<string> };
const questionHistory: QuestionVisit[] = [];
const linkId = (l: QLink) => `${l.source}:${l.target}`;
const stateOf = (q: string): State => statuses.get(q)?.state ?? "waiting";
const colour = (s: State) => `var(--${s === "pending" ? "running" : s})`;
const goals = () => cypher(GOALS) as Goal[];
const acceptance = () => new Set(goals().flatMap((g) => (g.acceptance ? [g.acceptance] : [])));

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

/** The lane of an asker: the part after the last /, before the first -. orchestrator/evolution and evolution-tools share one. */
const laneOf = (asker: string | null) => {
  const last = (asker ?? "").split("/").at(-1)!.trim();
  return (last.split("-")[0] || last || "unnamed").replaceAll("_", " ");
};

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

/** A glyph on its own, for the goal line, chips, refs and changes. */
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
// Trail: one HTML row per question, newest first, over one SVG that draws the rails.

const evidenceBack = document.getElementById("evidence-back") as HTMLButtonElement;
const trail = document.getElementById("trail")!;
const rails = s("svg", { class: "rails", "aria-hidden": "true" }) as SVGSVGElement;
const list = h("ol", { role: "listbox", "aria-label": "Questions" });
trail.append(rails, list);

const ROW = 32;
const COL = 20;
const PADX = 14;

function render() {
  const questions = [...nodes.values()].sort((a, b) => b.seq - a.seq);
  const focused = (document.activeElement as HTMLElement | null)?.closest?.("#trail .q")?.getAttribute("data-id") ?? null;
  if (!questions.length) {
    rails.replaceChildren();
    list.replaceChildren(h("li", { class: "empty" }, "No questions yet."));
    return;
  }
  // Lanes in the order their first question was asked.
  const lanes = [...new Set([...questions].reverse().map((q) => laneOf(q.asker)))];
  const gutter = PADX * 2 + (lanes.length - 1) * COL;
  trail.style.setProperty("--gutter", `${gutter}px`);
  trail.style.setProperty("--row", `${ROW}px`);
  const place = new Map(questions.map((q, i) => [q.id, { x: PADX + lanes.indexOf(laneOf(q.asker)) * COL, y: i * ROW + ROW / 2, row: i }]));
  const highlight = selected ? upstream([selected]) : null;
  const accepted = acceptance();
  rails.setAttribute("width", String(gutter));
  rails.setAttribute("height", String(questions.length * ROW));

  const laneLines = lanes.flatMap((name, i) => {
    const rows = questions.flatMap((q) => (laneOf(q.asker) === name ? [place.get(q.id)!.y] : []));
    const x = PADX + i * COL;
    return rows.length > 1 ? [s("line", { class: "rail", x1: x, x2: x, y1: Math.min(...rows), y2: Math.max(...rows) })] : [];
  });
  const paths = links.flatMap((l) => {
    // Evidence flows up: from the question that saved a file (older, lower) to the one that reads it.
    const [from, to] = [place.get(l.target), place.get(l.source)];
    if (!from || !to) return [];
    const lit = highlight?.links.has(linkId(l));
    const files = nodes.get(l.source)!.inputs.filter((i) => i.startsWith(`${l.target}/`)).map((i) => i.slice(l.target.length + 1));
    const mid = (from.y + to.y) / 2;
    const d = from.x === to.x
      ? `M ${from.x} ${from.y} C ${from.x + COL * 0.8} ${from.y}, ${to.x + COL * 0.8} ${to.y}, ${to.x} ${to.y}`
      : `M ${from.x} ${from.y} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${to.y}`;
    return [s("path", { d, class: `link${highlight ? (lit ? " lit" : " dim") : ""}` }, files.length ? s("title", {}, document.createTextNode(files.join(", "))) : null)];
  });
  const glyphs = questions.map((q) => {
    const p = place.get(q.id)!;
    const state = stateOf(q.id);
    const dim = highlight && !highlight.nodes.has(q.id);
    const g = s("g", { class: `node${dim ? " dim" : ""}`, transform: `translate(${p.x} ${p.y})` });
    if (accepted.has(q.id)) g.append(s("circle", { class: "accept-ring", r: 8, style: `--c: ${colour(state)}` }), glyph(state, 4));
    else g.append(glyph(state, 5.5));
    if (q.id === selected) g.append(s("circle", { class: "ring selected", r: 10.5 }));
    else if (marked.has(q.id)) g.append(s("circle", { class: "ring marked", r: 10.5 }));
    return g;
  });
  rails.replaceChildren(s("g", {}, ...laneLines), s("g", {}, ...paths), s("g", {}, ...glyphs));

  const tabStop = selected && place.has(selected) ? selected : questions[0]!.id;
  list.replaceChildren(
    ...questions.map((q) => {
      const state = stateOf(q.id);
      const accepts = accepted.has(q.id);
      const dim = highlight && !highlight.nodes.has(q.id);
      return h(
        "li",
        {
          class: `q${accepts ? " accepts" : ""}${dim ? " dim" : ""}${marked.has(q.id) ? " marked" : ""}`,
          role: "option",
          "aria-selected": String(q.id === selected),
          "aria-label": `${state}${accepts ? ", acceptance" : ""}: ${q.text}`,
          tabindex: q.id === tabStop ? "0" : "-1",
          title: q.text,
          "data-id": q.id,
        },
        h("span", { class: "text" }, q.text),
        h("span", { class: "lane" }, laneOf(q.asker)),
      );
    }),
  );
  if (focused) (list.querySelector(`[data-id="${focused}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
}

const rowOf = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>(".q");
list.addEventListener("click", (e) => {
  const row = rowOf(e);
  if (row) select(row.dataset.id!);
});
list.addEventListener("keydown", (e) => {
  const row = rowOf(e);
  if (!row) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    select(row.dataset.id!);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
    next?.focus();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Changes: each run that differs from the run before it on the same question.

const changeList = document.getElementById("change-list")!;
let changeSignature = "";

type Change = { q: string; at: number; from: string; to: string; diffs: string[] };

function changes(): Change[] {
  const runs = cypher(
    `MATCH (r:Run)-[:OF]->(q:Question)
     RETURN q.id AS q, q.rule AS rule, r.id AS run, r.started AS started, r.ms AS ms, r.answer AS answer, r.results AS results ORDER BY r.seq`,
  );
  const reads = new Map<string, Map<string, string>>();
  for (const r of cypher("MATCH (r:Run)-[x:READ]->(f:File) RETURN r.id AS run, x.name AS name, f.id AS file")) {
    const run = String(r.run);
    if (!reads.has(run)) reads.set(run, new Map());
    reads.get(run)!.set(String(r.name), String(r.file));
  }
  const parse = (v: unknown) => measurements(v ? (JSON.parse(String(v)) as Record<string, unknown>[]) : []);
  const before = new Map<string, Row>();
  const out: Change[] = [];
  for (const r of runs) {
    const q = String(r.q);
    const prev = before.get(q);
    before.set(q, r);
    if (!prev) continue;
    const diffs: string[] = [];
    const a = reads.get(String(prev.run)) ?? new Map(), b = reads.get(String(r.run)) ?? new Map();
    for (const name of new Set([...a.keys(), ...b.keys()]))
      if (a.get(name) !== b.get(name)) diffs.push(`${name}  ${a.get(name)?.slice(0, 6) ?? "–"} → ${b.get(name)?.slice(0, 6) ?? "–"}`);
    const [ma, mb] = [parse(prev.results), parse(r.results)];
    for (const n of named(String(r.rule)))
      if (n !== "results" && JSON.stringify(ma[n]) !== JSON.stringify(mb[n])) diffs.push(`${n}  ${show(ma[n]) ?? "–"} → ${show(mb[n]) ?? "–"}`);
    if (prev.answer !== r.answer || diffs.length)
      out.push({ q, at: Number(r.started) + Number(r.ms), from: String(prev.answer), to: String(r.answer), diffs });
  }
  return out.reverse();
}

function renderChanges() {
  const all = changes();
  const accepted = acceptance();
  const signature = JSON.stringify([all, [...accepted]]);
  if (signature === changeSignature) return;
  changeSignature = signature;
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  changeList.replaceChildren(
    ...(all.length
      ? all.map((c) => {
          const accepts = accepted.has(c.q);
          const text = h("button", { type: "button", class: "change-text", title: nodes.get(c.q)?.text ?? c.q }, nodes.get(c.q)?.text ?? c.q);
          text.onclick = () => select(c.q);
          return h(
            "li",
            { "data-id": c.q },
            h("time", {}, time(c.at)),
            h("span", { class: "flip" }, ...(c.from === c.to ? [mark(c.to as State, 11, accepts)] : [mark(c.from as State, 11, accepts), "→", mark(c.to as State, 11, accepts)])),
            text,
            c.diffs.length ? h("div", { class: "diffs" }, ...c.diffs.map((d) => h("code", {}, d))) : null,
          );
        })
      : [h("li", { class: "hint" }, "No changes")]),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Narrow screens: one view at a time.

const narrow = matchMedia("(max-width: 860px)");
const viewButtons = [...document.querySelectorAll<HTMLButtonElement>("#views button")];
function setView(view: string) {
  document.body.dataset.view = view;
  for (const b of viewButtons) b.setAttribute("aria-selected", String(b.dataset.view === view));
}
for (const b of viewButtons) b.onclick = () => setView(b.dataset.view!);
setView("trail");

// ---------------------------------------------------------------------------------------------------------------
// Back

function rememberQuestion(next: string) {
  if (!selected || selected === next) return;
  const panel = document.getElementById("question")!;
  questionHistory.push({
    id: selected,
    scroll: panel.scrollTop,
    trail: trail.scrollTop,
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
let trailDirty = false;
let evidenceDirty = false;

/** Coalesce a burst of records and statuses into one display update. */
function scheduleDisplay(redraw = false, evidence = false) {
  trailDirty ||= redraw;
  evidenceDirty ||= evidence;
  if (displayFrame !== null) return;
  displayFrame = requestAnimationFrame(() => {
    displayFrame = null;
    const drawTrail = trailDirty, drawEvidence = evidenceDirty;
    trailDirty = evidenceDirty = false;
    if (drawTrail) { renderGoals(); render(); renderChanges(); }
    if (drawEvidence && selected) showQuestion(selected);
  });
}

/** Chip glyphs can change when a linked question changes. */
function panelQuestions() {
  const ids = selected ? upstream([selected]).nodes : new Set<string>();
  for (const l of links) if (l.target === selected) ids.add(l.source);
  return ids;
}

function apply(m: Msg) {
  let evidence = false;
  if (m.type === "graph") {
    for (const st of statements(m.nodes, m.rels)) cypher(st.cypher, st.params);
    evidence = selected !== null && m.rels.some((r) =>
      (r.type === "OF" && r.to === selected) ||
      r.type === "FOR" ||
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
    const watched = new Set([...panelQuestions(), ...exploration()]);
    evidence = [...watched].some((id) => JSON.stringify(statuses.get(id)) !== JSON.stringify(next.get(id)));
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
// Goals: one line for the chosen goal, and a menu of all goals.

const goalLine = document.getElementById("goal-line") as HTMLButtonElement;
const goalMenu = document.getElementById("goal-menu")!;
let goalSignature = "";

function renderGoals() {
  const all = goals();
  const goalState = (g: Goal): State => (g.acceptance ? stateOf(g.acceptance) : "waiting");
  const signature = JSON.stringify([selectedGoal, all.map((g) => [g.id, g.text, g.acceptance, goalState(g)])]);
  if (signature !== goalSignature) {
    goalSignature = signature;
    const label = (g: Goal) => (all.filter((o) => o.text === g.text).length > 1 ? `${g.text} (${g.id})` : g.text);
    const current = all.find((g) => g.id === selectedGoal);
    goalLine.dataset.current = selectedGoal;
    goalLine.title = current ? `${current.text} (${current.id})` : "All questions";
    goalLine.replaceChildren(...(current ? [mark(goalState(current), 13, true), h("span", {}, label(current))] : [h("span", {}, "All questions")]));
    const option = (id: string, text: string, state?: State) => {
      const b = h("button", { type: "button", role: "menuitemradio", class: "goal-option", "aria-checked": String(id === selectedGoal), "data-goal": id }, state ? mark(state, 12, true) : null, h("span", {}, text));
      b.onclick = () => {
        goalMenu.hidePopover?.();
        chooseGoal(id);
      };
      return b;
    };
    goalMenu.replaceChildren(...all.map((g) => option(g.id, label(g), goalState(g))), option("", "All questions"));
  }
  if (!goalInitialized && all.length) {
    goalInitialized = true;
    if (!selected) { chooseGoal(all[0]!.id); return; }
  }
  // A newly bound acceptance question opens an otherwise empty goal view.
  if (selectedGoal && !selected) {
    const accepts = all.find((g) => g.id === selectedGoal)?.acceptance;
    if (accepts) select(accepts);
  }
}
goalLine.onclick = () => chooseGoal(selectedGoal);

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
    if (!id) trail.scrollTop = 0;
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
  const a = h("span", { class: "ref id" }, mark(stateOf(q), 10, acceptance().has(q)), q);
  a.onclick = () => select(q);
  return a;
}

/** Another question, by its text. */
function chip(q: string) {
  const b = h("button", { type: "button", class: "chip", title: q }, mark(stateOf(q), 12, acceptance().has(q)), h("span", {}, nodes.get(q)?.text ?? q));
  b.onclick = () => select(q);
  return b;
}

/** What the selected question depends on, as a tree. Each question shows once. */
function tree(qid: string, seen = new Set([qid])): HTMLElement | null {
  const deps = links.filter((l) => l.source === qid && !seen.has(l.target)).map((l) => l.target);
  for (const d of deps) seen.add(d);
  return deps.length ? h("ul", { class: "tree" }, ...deps.map((d) => h("li", {}, chip(d), tree(d, seen)))) : null;
}

/** The exploratory questions of the goals that the selected question accepts. */
function exploration(): string[] {
  if (!selected) return [];
  return cypher(
    "MATCH (g:Goal)-[:ACCEPTED_BY]->(:Question {id: $id}) MATCH (e:Question)-[:FOR]->(g) RETURN DISTINCT e.id AS id, e.seq AS seq ORDER BY seq DESC",
    { id: selected },
  ).map((r) => String(r.id));
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
  const explored = d.accepts.length ? exploration() : [];
  const dependsOn = tree(qid);
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
      d.asker ? h("span", {}, d.asker) : null,
      h("span", { class: "id" }, qid),
    ),
    h("h2", {}, d.text),
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
    ...(dependsOn ? [h("h3", {}, "Depends on"), dependsOn] : []),
    ...list("Used by", d.usedBy),
    ...list("Answered no", explored.filter((e) => stateOf(e) === "no")),
    ...list("Failed", explored.filter((e) => stateOf(e) === "failed")),
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
    h("div", { class: "disclosures" }, probeDetails, runsDetails),
  ];
  panel.replaceChildren(...parts.filter((x) => x !== null));
}

function select(qid: string, previous?: QuestionVisit) {
  if (!previous) rememberQuestion(qid);
  if (previous) marked = new Set(previous.marked);
  selected = qid;
  updateEvidenceBack();
  if (narrow.matches) setView("evidence");
  showQuestion(qid);
  const panel = document.getElementById("question")!;
  const probe = panel.querySelector<HTMLDetailsElement>("details.probe");
  const runs = panel.querySelector<HTMLDetailsElement>("details.runs-disclosure");
  if (probe && previous) probe.open = previous.probeOpen;
  if (runs && previous) runs.open = previous.runsOpen;
  panel.scrollTop = previous?.scroll ?? 0;
  render();
  if (previous) {
    trail.scrollTop = previous.trail;
    if (evidenceBack.hidden) {
      const heading = panel.querySelector("h2")!;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    return;
  }
  list.querySelector(`[data-id="${qid}"]`)?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------------------------------------------------------
// Search: plain words find questions; a query that starts like Cypher runs on Enter.

const PRESETS = [
  "MATCH (g:Goal)\nOPTIONAL MATCH (g)-[:ACCEPTED_BY]->(q:Question)\nRETURN g.id AS goal, g.text AS text, q.id AS acceptance, q.id IN $yes AS yes ORDER BY g.seq",
  "MATCH (r:Run {answer: 'failed'})-[:OF]->(q:Question)\nRETURN q.id AS id, r.reason AS reason, r.seq AS seq ORDER BY seq DESC",
  "MATCH (q:Question)<-[:OF]-(r:Run)-[x:READ]->(:File)\nWHERE r.id IN $current AND NOT x.name STARTS WITH 'q-'\nRETURN x.name AS input, collect(DISTINCT q.id) AS questions ORDER BY input",
];
const CYPHER = /^\s*(MATCH|OPTIONAL|WITH|UNWIND|RETURN|CALL)\b/i;

const search = document.getElementById("search")!;
const input = document.getElementById("search-input") as HTMLTextAreaElement;
const results = document.getElementById("results")!;

function grow() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

function setMarked(next: Set<string>) {
  marked = next;
  scheduleDisplay(true);
}

function onSearch() {
  grow();
  const v = input.value.trim();
  if (!v) {
    setMarked(new Set());
    results.hidden = !search.contains(document.activeElement);
    results.replaceChildren(
      ...PRESETS.map((q) => {
        const b = h("button", { type: "button", class: "preset" }, h("code", {}, q));
        b.onclick = () => showQuery(q);
        return b;
      }),
    );
    return;
  }
  if (CYPHER.test(v)) return;
  const words = v.toLowerCase();
  const found = [...nodes.values()]
    .filter((q) => q.text.toLowerCase().includes(words) || q.id === words || laneOf(q.asker).toLowerCase().includes(words))
    .sort((a, b) => b.seq - a.seq);
  setMarked(new Set(found.map((q) => q.id)));
  results.hidden = false;
  results.replaceChildren(found.length ? h("div", { class: "matches" }, ...found.slice(0, 50).map((q) => chip(q.id))) : h("p", { class: "hint" }, "No matches"));
}

function closeSearch() {
  input.value = "";
  grow();
  results.hidden = true;
  results.replaceChildren();
  setMarked(new Set());
  input.blur();
}

input.addEventListener("input", onSearch);
input.addEventListener("focus", () => { if (!input.value.trim()) onSearch(); });
search.addEventListener("focusout", (e) => {
  if (!search.contains(e.relatedTarget as Node | null) && !input.value.trim()) results.hidden = true;
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  } else if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (CYPHER.test(input.value)) runQuery();
    else (results.querySelector(".chip") as HTMLButtonElement | null)?.click();
  } else if (e.key === "ArrowDown" && !CYPHER.test(input.value)) {
    const first = results.querySelector<HTMLElement>("button");
    if (first) { e.preventDefault(); first.focus(); }
  }
});
results.addEventListener("keydown", (e) => {
  const buttons = [...results.querySelectorAll<HTMLElement>("button")];
  const i = buttons.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  if (e.key === "ArrowDown") { e.preventDefault(); buttons[i + 1]?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); (buttons[i - 1] ?? input).focus(); }
  else if (e.key === "Escape") closeSearch();
});
document.addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
  if ((e.key === "/" && !typing) || (e.key === "k" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    input.focus();
  }
});

/** Question ids in a value: the value itself, or the items of a list. */
const idsIn = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(idsIn) : typeof v === "string" && nodes.has(v) ? [v] : []);

/** The parameters every query in the page gets: the answers now, and the selected question and its current run. */
const params = () => ({
  ...answerParams([...statuses.values()], goals()),
  selected,
  run: (selected && statuses.get(selected)?.run) ?? null,
});

/** Runs the Cypher in the search bar, shows the rows, and marks the questions they name. Returns the rows, or the error. */
function runQuery(): { columns: string[]; rows: Row[] } | Error {
  results.hidden = false;
  if (input.value.includes("$selected") && !selected) {
    results.replaceChildren(h("p", { class: "hint" }, "Select a question first."));
    return new Error("No question is selected, and this query uses $selected. Select one first.");
  }
  try {
    const r = result(input.value, params());
    setMarked(new Set(r.rows.flatMap((row) => Object.values(row).flatMap(idsIn))));
    const cell = (v: unknown): Node | string => {
      const found = idsIn(v);
      if (found.length && (typeof v === "string" || (Array.isArray(v) && found.length === v.length)))
        return h("span", {}, ...found.flatMap((x, i) => (i ? [" ", ref(x)] : [ref(x)])));
      return typeof v === "string" ? v : JSON.stringify(v);
    };
    results.replaceChildren(
      r.rows.length
        ? h("table", {}, h("tr", {}, ...r.columns.map((c) => h("th", {}, c))), ...r.rows.map((row) => h("tr", {}, ...r.columns.map((c) => h("td", {}, cell(row[c]))))))
        : h("p", { class: "hint" }, "No rows"),
    );
    return r;
  } catch (e) {
    setMarked(new Set());
    results.replaceChildren(h("p", { class: "error" }, (e as Error).message));
    return e as Error;
  }
}

/** Puts a query in the search bar and runs it. Evidence stays open on the right. */
function showQuery(query: string) {
  input.value = query;
  grow();
  if (narrow.matches) setView("trail");
  return runQuery();
}

renderGoals();
render();
renderChanges();
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
