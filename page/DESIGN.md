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

The page shows a record of evidence, not a dashboard. A person comes to it to answer two questions: how did the agents get here, and why does each answer stand. The lanes answer the first. The rule check answers the second.

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
┌ Witness   ● 10 yes  ● 5 no  ⊘ 2 failed                         connected ┐
├─────────────────────────────────────────────────────────┬─────────────────────┤
│ trees         ⊘  ⊘  ●───────●──●                          │ ● yes  q-…  trees   │
│ clique_paths     ●     ●       ●──╌╌●                     │ Question text       │
│ evolution     ●          ●             ●                  │                     │
│ verification     ●  ●  ●──╌╌●   ●──●                      │ Yes when            │
│                                                          │ $margin < -1e-8     │
│                                                          │   −0.0501  true     │
├──────────────────────────────────────────────────────────┤                     │
│ Previous  Next   3 of 17   Question…   ───●────────────── │ picture, links …    │
└──────────────────────────────────────────────────────────┴─────────────────────┘
```

- **Lanes.** The x position is the order a question was asked. Each row is one direction of work, taken from the asker: `orchestrator/evolution` and `evolution-tools` both go in the lane `evolution`. The layout never moves on its own, so a person can learn it.
- **Links.** A solid curve runs from a question to each question that reads its output.
- **Evidence panel.** A fixed column on the right. It opens on the answer, the question and the rule check, then the saved pictures, then what the question rests on, then the raw record.
- **Back.** A quiet control beside the Evidence tab, visible after following another question. It restores the previous reading position. Previous and Next follow question order.
- **Question navigation.** A bar under the lanes, never over them. Previous, Next and the timeline select questions immediately. The position follows the selected question, including selections made through WebMCP.
- Content is left aligned. Below 860px the panel moves under the lanes.

## Elevation & Depth

The page is flat. Regions are separated by a 1px `line` rule and by the change from `paper` to `surface`. There are no shadows.

## Shapes

- Question glyphs are 9px discs: filled for an answer, hollow for no answer yet, a slashed ring for failed.
- The selected question gets an ink ring.
- Buttons and chips use a 4px radius. Verdict badges are fully rounded. Panels and clauses have square corners.

## Components

- **Verdict badge.** The answer as a word on its colour: `yes`, `no`, `failed`. `pending`, `running` and `waiting` are outlined, because they are not answers.
- **Rule check.** The rule split at its top-level `AND`s, one clause per row. Each row shows the clause in mono, the measured values it names, and whether it is true, false or not measured. A 4px bar on the left takes the colour of that result. The page evaluates each clause with its own Relate copy, on the run's measurements. The answer itself still comes from the run.
- **Question chip.** A link to another question: its glyph, then the start of its text. Never a bare id.
- **Headline.** Counts by answer.

## Do's and Don'ts

- Do show a measurement next to the clause that uses it.
- Do encode every answer by shape as well as colour.
- Show navigation and evidence immediately. A question stays selected until the reader or browser agent chooses another.
- Don't use cards, shadows or gradients.
- Don't add labels that repeat what the content already says.
- Don't explain the page in sentences. Labels are one to three words. A legend draws the mark it names.
- Don't show an id where the question's text fits.
- Do write all page text in plain English, close to ASD-STE100: one word for one meaning, simple verbs, no figures of speech such as "rests on" or "survived".
- Don't animate the lanes into place: they hold still so a person can read them.
