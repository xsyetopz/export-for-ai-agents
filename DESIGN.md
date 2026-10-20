---
name: Export for AI Agents
description: Toolbar popup that exports the current page as Markdown or JSONL; a Swiss typographic sheet.
colors:
  ultramarine: "#1f2a9e"
  ultramarine-bright-dark: "#3a48d6"
  ultramarine-ink-dark: "#a5aeff"
  band-ink: "#ffffff"
  band-tint: "#c9ceff"
  tint: "#d6d9ff"
  tint-dark: "#2c3380"
  paper: "#ffffff"
  paper-dark: "#0d0e13"
  ink: "#101218"
  ink-dark: "#f1f2f6"
  muted: "#4d5260"
  muted-dark: "#a6aab8"
  rule: "#c4c7d0"
  rule-dark: "#3a3d4a"
  amber: "#8a5a00"
  amber-dark: "#f0b429"
  red: "#b3261e"
  red-dark: "#ff8f86"
typography:
  numeral:
    fontFamily: "\"Helvetica Neue\", Helvetica, Arial, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
    fontFeature: "\"tnum\""
  heading:
    fontFamily: "\"Helvetica Neue\", Helvetica, Arial, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "\"Helvetica Neue\", Helvetica, Arial, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "\"tnum\""
  note:
    fontFamily: "\"Helvetica Neue\", Helvetica, Arial, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "\"Helvetica Neue\", Helvetica, Arial, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: "0px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
components:
  band:
    backgroundColor: "{colors.ultramarine}"
    textColor: "{colors.band-ink}"
    typography: "{typography.heading}"
    height: "40px"
    padding: "0 16px"
  button-primary:
    backgroundColor: "{colors.ultramarine}"
    textColor: "{colors.band-ink}"
    typography: "{typography.heading}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ultramarine}"
    typography: "{typography.heading}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
  button-outline-hover:
    backgroundColor: "{colors.tint}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.ultramarine}"
    typography: "{typography.body}"
    padding: "8px 0"
  segment:
    backgroundColor: "transparent"
    textColor: "{colors.ultramarine}"
    typography: "{typography.heading}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
  segment-selected:
    backgroundColor: "{colors.ultramarine}"
    textColor: "{colors.band-ink}"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "8px"
---

# Design System: Export for AI Agents

## Overview

**Creative North Star: "The Swiss Typographic Sheet".**

The popup is one flush-left sheet on a single grid, where type and numbers carry the interface. A deep ultramarine band names the tool and the host; below it, plain paper (white in light, near-black in dark) holds a segmented format switch, a row of large tabular numerals, and the actions. Structure comes from 1px rules and alignment, not from containers.

It is dense and quiet: a tool, not a destination. Ultramarine is the only voice. Amber and red appear only when the output is incomplete or broken. Light and dark follow `prefers-color-scheme`, with no toggle.

**Key Characteristics:**

- One 3-column grid shared by the coverage row and the actions row.
- Zero radius, 1px rules, no shadows, no gradients.
- System sans in two weights (400/600) with tabular figures throughout.
- Ultramarine for band, primary fill, selected segment, links and focus; amber and red only for state.

## Colors

One saturated ultramarine against neutral paper and ink, plus two state colors. Every color has a light and a dark value; dark tokens carry the `-dark` suffix and swap in under `prefers-color-scheme: dark`.

### Primary

- **Deep Ultramarine** (ultramarine): the header band in both schemes, and the primary-button fill, selected segment, outline/text-button ink and focus ring in light.
- **Bright Ultramarine** (ultramarine-bright-dark): replaces it as the primary fill and selected segment in dark, where deep ultramarine is too heavy on near-black.
- **Ultramarine Ink** (ultramarine-ink-dark): the dark-scheme ink for outline and text buttons, segment borders, focus ring and caret.
- **Band Tint** (band-tint): the host name inside the band, a step quieter than the band's white title.
- **Selection Tint** (tint / tint-dark): text selection and outline-button hover.

### Neutral

- **Paper** (paper / paper-dark): the body background.
- **Ink** (ink / ink-dark): body text and numerals.
- **Muted Slate** (muted / muted-dark): labels, notes, hints, disabled buttons.
- **Rule Grey** (rule / rule-dark): every 1px divider and field border.

### State

- **Amber** (amber / amber-dark): the "not captured" numeral and its explanatory note. Meaning: the output is incomplete.
- **Signal Red** (red / red-dark): error text and the 1px top rule above it. Meaning: the export failed.

**The One Voice Rule.** Ultramarine is the only accent. Amber and red are never decorative; each appears only when its state is true.

**The Honest Number Rule.** A numeral changes color only to report a state (amber when something was not captured). It never changes color for emphasis.

## Typography

**Font:** "Helvetica Neue", with Helvetica, Arial and system-ui as fallbacks. No web fonts, by constraint.
**Mono:** ui-monospace, with SFMono-Regular, Menlo and Consolas as fallbacks. Used only for the preview text.

**Character:** a neo-grotesque in two weights, with figures set tabular so numbers line up down the columns.

### Hierarchy

- **Numeral** (600, 40px, 1.1, -0.02em): the coverage counts. The largest type on the sheet, and the signature.
- **Heading** (600, 14px): tool name, segment labels, button labels, the "Advanced" summary.
- **Body** (400, 14px, 1.4): error text and field values.
- **Note** (400, 13px): host in the band, the coverage note, the retry hint.
- **Label** (400, 12px, muted): labels under numerals, field labels, legends, hints.
- **Mono** (400, 12px, 1.5): read-only preview, unwrapped and scrolling horizontally.

**The Two Weights Rule.** Only 400 and 600. Hierarchy comes from size and color, never from a third weight.

## Layout

A fixed 360px sheet. The band is 40px tall with 16px side padding. The main area has 24px top and 16px side/bottom padding. Spacing comes from a 4/8/12/16/24 scale; sections are separated by 24px with a 1px rule.

**The Shared Grid Rule.** The coverage row and the actions row use the same `repeat(3, 1fr)` grid with a 16px gap, so Copy sits under the first numeral, Save under the second and Refresh under the third. New rows of peers join this grid instead of inventing their own.

Error and unsupported states hide the coverage row, and unsupported also hides the actions, so the sheet collapses and nothing empty is left behind. Advanced is an inline disclosure at the bottom; fields inside it stack full-width with 12px between them.

## Elevation & Depth

Flat. There are no shadows, gradients or layered surfaces. Depth comes only from the ultramarine band against paper and from 1px rules.

**The Rule-Not-Box Rule.** Group content with a single 1px top rule, not a bordered or filled card.

## Shapes

Square everywhere: radius is 0 for every element. The 1px stroke is the only line weight; the focus ring is 2px with a 2px offset.

## Components

### Buttons

- **Shape:** square (0), 8px × 12px padding, 600 weight.
- **Primary (Copy):** ultramarine fill, white label. Exactly one per sheet.
- **Outline (Save):** 1px ultramarine-ink border and label on a transparent background; tint fill on hover.
- **Text (Refresh):** underlined ultramarine-ink label, 3px underline offset, no box.
- **Disabled:** rule-grey border, transparent fill, muted label.
- **Motion:** background, color and border change over 120ms ease-out. Reduced motion removes all transitions.

### Segmented Control (Format)

Two equal cells sharing one 1px ultramarine border (adjacent borders overlap by 1px). The selected cell is filled ultramarine with white text; the unselected cell is ultramarine-ink text on paper. Built on native radios; the focus ring is drawn on the cell.

### Coverage Row (Signature)

Three stats, each a 40px tabular numeral over a 12px muted label, on the shared grid below a 1px rule. The middle stat ("Not captured") turns amber when anything was dropped, and a one-line note below explains why.

### Inputs / Fields

- **Style:** 1px rule-grey border, paper background, ink text, 8px padding, square.
- **Label:** 12px muted label above the field, 4px gap.
- **Focus:** 2px ultramarine-ink outline, 2px offset.

### Error Block

Red text under a 1px red top rule, with an optional muted retry line. No fill and no icon.

### Disclosure (Advanced)

A full-width summary under a 1px rule: a 10px stroked chevron that rotates 90° when open, then a 600-weight label. The native marker is hidden. The chevron is the only drawn mark in the system.

## Do's and Don'ts

### Do

- **Do** align any new row of three peers to the shared 3-column grid with a 16px gap.
- **Do** separate sections with a single 1px rule and 24px of space.
- **Do** keep numbers tabular and let the numerals be the largest type.
- **Do** define every color as a light/dark pair that switches with `prefers-color-scheme`.

### Don't

- **Don't** add a radius, a shadow or a gradient.
- **Don't** use amber or red for anything but incomplete output and errors.
- **Don't** add a third font weight or a web font.
- **Don't** add icons to buttons or labels; the text is the control.
