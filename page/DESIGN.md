---
version: alpha
name: Witness
description: The page where a person watches agents' questions get answered, and checks why.
colors:
  paper: "#EEF1EF"
  surface: "#FBFCFB"
  ink: "#16201B"
  muted: "#5B6862"
  line: "#D3DAD6"
  yes: "#1D7A48"
  no: "#C2412B"
  failed: "#6E7681"
  running: "#B8791A"
  accent: "#2B55C9"
  paper-dark: "#1B201E"
  surface-dark: "#222826"
  ink-dark: "#E7ECE9"
  muted-dark: "#9AA6A0"
  line-dark: "#343C38"
  yes-dark: "#4CB37A"
  no-dark: "#E26A52"
  failed-dark: "#9AA3AD"
  running-dark: "#D9A23E"
  accent-dark: "#8FA9F5"
typography:
  question:
    fontFamily: Atkinson Hyperlegible Next Variable
    fontSize: 1.25rem
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: Atkinson Hyperlegible Next Variable
    fontSize: 0.9375rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Atkinson Hyperlegible Next Variable
    fontSize: 0.8125rem
    fontWeight: 600
    lineHeight: 1.3
  rule:
    fontFamily: Atkinson Hyperlegible Mono Variable
    fontSize: 0.9375rem
    fontWeight: 500
    lineHeight: 1.4
  value:
    fontFamily: Atkinson Hyperlegible Mono Variable
    fontSize: 1.0625rem
    fontWeight: 600
    lineHeight: 1.2
    fontFeature: '"tnum"'
  code:
    fontFamily: Atkinson Hyperlegible Mono Variable
    fontSize: 0.8125rem
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: 0px
  sm: 4px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
components:
  verdict-yes:
    backgroundColor: "{colors.yes}"
    textColor: "{colors.surface}"
    rounded: "{rounded.full}"
  verdict-no:
    backgroundColor: "{colors.no}"
    textColor: "{colors.surface}"
    rounded: "{rounded.full}"
  verdict-failed:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.failed}"
    rounded: "{rounded.full}"
  clause:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.rule}"
    rounded: "{rounded.none}"
    padding: 12px
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: 6px 12px
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
---

# Witness page

## Overview

The page shows a record of evidence, not a dashboard. A person comes to it to answer two questions: how did the agents get here, and why does each answer stand. The lanes answer the first. The rule check answers the second. The goal dropdown opens the acceptance question. Every selection highlights that question’s input chain, while hovering previews any question in a steady strip above the lanes. The evidence panel stays open on the right, even while running Cypher in the docked query drawer.

The tone is a lab notebook kept by a careful clerk: plain, legible, and exact. Nothing on the page is decoration. Every mark is a question, a link between questions, or a measurement.

One element is allowed to be bold: the rule check. Everything around it stays quiet.

## Colors

The base is a cool grey-green paper with near-black green ink. It reads as paper under daylight, not as cream and not as a dark console.

Colour carries the answer and nothing else:

- `yes` is a deep green, `no` a vermilion, `running` an amber.
- `failed` is grey, and it never relies on colour alone. A failed question is a hollow ring with a slash, so it cannot be mistaken for `no` or for waiting.
- `accent` blue is only for things a person can act on: links, keyboard focus, query matches.
- Selection is drawn in ink, not in a colour.

The dark set keeps the same roles with lighter answer colours, so each still passes contrast on the dark surface.

## Typography

One family in two cuts. Atkinson Hyperlegible Next sets all prose and labels. It was drawn for legibility, and its numerals and letters cannot be confused, which suits a page whose job is to be read exactly. Atkinson Hyperlegible Mono sets code only: rules, probes, Cypher, ids and measured values. Measured values use tabular figures so columns of numbers line up.

- Question text is the largest type on the page, at 20px.
- Labels are sentence case at 13px semibold. No all-caps, no tracking.
- No line runs past about 70 characters.

## Layout

```
┌ Witness                                                       connected ┐
│ Sort records without losing duplicates                              ▾ │
├─────────────────────────────────────────────────────────┬───────────────┤
│ ● yes · With warm-start B&B, all 50 ≤ 200 ms     branch │ yes  q-…      │
├─────────────────────────────────────────────────────────┤ Question text │
│ trees         ⊘──⊘                                      │               │
│ clique_paths  ●──●───────●                              │ Rule          │
│ evolution     ●──────────┘ ╲                            │ $margin < 0   │
│ verification                ●──◎                        │   −0.05  true │
├─────────────────────────────────────────────────────────┤               │
│ ▸ Query                                                 │ ▸ Probe ▸ Run │
└─────────────────────────────────────────────────────────┴───────────────┘
```

- **Goal dropdown.** A native dropdown below the header names the chosen goal. Selecting a goal opens its acceptance question; a goal without one shows No acceptance question in the panel. All questions clears the selection. First load opens the first goal when there is no selection. Live arrivals preserve the reader’s choice. There are no completion banners.
- **Step slider (`seq`).** A range control on the right of the goal bar steps across recorded `seq` order, updating glyphs, Evidence and queries to that step in place.
- **Hover strip.** A steady single-line bar above the lanes shows the hovered or focused question’s state, full text and lane without covering nearby dots or shifting the layout.
- **Lanes.** One row per direction of work, taken from the asker: `orchestrator/evolution` and `evolution-tools` both go in the lane `evolution`. Glyphs carry no inline text labels; parallel work shares columns while preserving creation order within each lane and left-to-right causal order across dependencies. Arrow keys move across dots.
- **Links.** A curve runs from a question to each question that reads its output. Selecting any question highlights its upstream chain; choosing a goal selects its acceptance question. Other exploration stays readable. Links carry the consumed artifact names as hover titles.
- **Query drawer.** Docked below the lanes on the left so running Cypher and clicking result ids keeps Evidence open on the right.
- **Evidence panel.** A fixed column on the right. It opens on the answer, question, asker and rule check, followed by saved images, any measurements not already shown in the rule clauses, input and saved file links, dependencies, and disclosures for the probe and run history. No goal summary repeats the goal bar.
- **Back.** A quiet control in the Evidence header, visible after following another question. It restores the previous question, reading position and expanded disclosures. Its dependency highlight is derived again from that question.
- **Evidence navigation.** Choose a goal from the dropdown to open its acceptance question, then follow dependency and consumer chips. Graph selection, query results and WebMCP show_question also open evidence directly and use the same selection-derived highlight.
- Content is left aligned. Below 860px the panel moves under the lanes.

## Elevation & Depth

The page is flat. Regions are separated by a 1px `line` rule and by the change from `paper` to `surface`. There are no shadows.

## Shapes

- Exploratory question glyphs are 8.5px discs: filled for an answer, hollow for no answer yet, a slashed ring for failed.
- Acceptance questions add an outer ring in the verdict colour (`◎`) so they stand out from exploration.
- The selected question gets an outer ink ring; hovered questions get a muted ring; query matches get an accent ring.
- Buttons and chips use a 4px radius. Verdict badges are fully rounded. Panels and clauses have square corners.

## Components

- **Verdict badge.** The answer as a word on its colour: `yes`, `no`, `failed`. `pending`, `running` and `waiting` are outlined, because they are not answers.
- **Rule check.** The rule split at its top-level `AND`s, one clause per row. Each row shows the clause in mono, the measured values it names, and whether it is true, false or not measured. A 4px bar on the left takes the colour of that result. The page evaluates each clause on its own empty, read-only Relate store, on the run's measurements. The answer itself still comes from the run.
- **Measurements.** Measurements already displayed beside a rule clause are not repeated below. Additional recorded names and exact JSON values appear in a Measurements table. With multiple result records, label the values Last value and expose every record under All measurements. Never infer units, rename measurements or round them. Pending and running tests show no stale values as current.
- **Files.** A table of input and saved files. Input links refer to the content hash read by the displayed run, not the mutable workspace path. Declared inputs without a committed run remain plain names.
- **Question chip.** A link to another question: its glyph, then the start of its text. Never a bare id.
- **Header.** The name, connection state and evidence toggle. The selected question’s result appears in evidence.

## Do's and Don'ts

- Do show a measurement next to the clause that uses it.
- Do encode every answer by shape as well as colour.
- Show navigation and evidence immediately. A question stays selected until the reader or browser agent chooses another.
- Don't use cards, shadows or gradients.
- Don't add labels that repeat what the content already says.
- Don't explain the page in sentences. Labels are one to three words. A legend draws the mark it names.
- Don't show an id where the question's text fits.
- Show the test and its measurements; do not add Complete or Incomplete banners.
- Do write all page text in plain English, close to ASD-STE100: one word for one meaning, simple verbs, no figures of speech such as "rests on" or "survived".
- Don't animate the lanes into place: they hold still so a person can read them.
