# Design

## Context

`src/normalize.ts` scans code spans per line (`codeSpans`), checks the next line against `BLOCK_START` before
adding a `\` hard break, and escapes `<letter` outside spans in `fixProse`. The 2.4 review required all scans to
be linear (40k-char inputs under 5 ms). See proposal.md for the findings.

## Goals / Non-Goals

**Goals:** fix the three edge cases and the two limits (code spans across lines, reference definitions), keeping
every scan linear.

**Non-Goals:** full CommonMark block and HTML-block rules. The block-start test stays an approximation (see
Risks). These stay documented limits.

## Decisions

- **Escaped run (`codeSpans`).** When an odd number of backslashes precedes a run of length `len > 1`, push it as
  an opener at `pos + 1` with `len - 1` instead of a non-opener. A run of length 1 stays a non-opener. The
  same-length `next` matching then works unchanged. Alternative (full CommonMark backslash handling over the
  whole line) is more code for no gain here.
- **`BLOCK_START`.** Replace the trailing `<` alternative with `<[A-Za-z/!?]`. This matches the start of the
  HTML block kinds that matter (tags, closing tags, comments/declarations, processing instructions) without
  modelling all seven CommonMark types.
- **Link destination (`fixProse`).** Replace the fixed `](` check at `off - 2` with a backward scan from `off`
  over spaces and tabs, at most one line break, then spaces and tabs, then check for `](`. A manual loop, not a
  `/\]\([ \t]*$/` test on a growing slice, which would be quadratic on lines with many `<`. Each scan stops at
  the whitespace run before its `<`, and those runs do not overlap, so the total stays linear.
- **Paragraph groups (`normalizeBody`).** Consecutive prose lines form a group. A group ends at a blank line, at a
  line of only `>` quote markers, at a code line (`scanCode` mask), and before a line that can interrupt a paragraph
  under CommonMark's rules (list item, with ordered lists only from 1; heading; thematic break; fence; setext underline;
  HTML block types 1-6), tested by a narrower regex than `BLOCK_START`, which still governs hard breaks. A `>` line
  continues the group only when the previous line also starts with `>`. An ATX heading line is a group by itself. A line
  also continues the group when the previous line ends with `](` or is a bare `[label]:` line, so a destination on the
  next line stays attached. `codeSpans` and the `<` escaping run over the group text, lines joined with `\n`, so a span
  can cross lines. Quote markers stay in the group text; that is good enough for deciding what not to escape. A line
  that ends inside a span gets no `\` hard break, since the break would show as a literal backslash in code. Its
  trailing whitespace is still stripped. No hard break is added after a line ending in `](` or a bare `[label]:` line
  either, since the `\` would land inside the destination. Each group is scanned once, so the work stays linear.
- **Reference definitions (`fixProse`).** A definition line matches `^ {0,3}(?:>[ \t]*)*\[label\]:`, where the
  label is 1 to 999 characters with no unescaped brackets. A definition line counts only as the first line of a
  group or right after another definition line, because a definition cannot interrupt a paragraph. The `<` that
  opens the destination (after `:`, optional spaces or tabs, at most one line break, then spaces or tabs) is not
  escaped. The check is one bounded regex per candidate line, so it stays linear.
- **Docs.** Update the `normalizeBody` doc comment: drop the two fixed limits and list the approximations that
  remain (see Risks). The `scanCode` limits stay where they are.

## Risks / Trade-offs

- [Pathological input: many `<` each after a long run of spaces] → each scan is bounded by its own run; runs
  don't overlap, so total work stays linear in line length.
- [Changing `BLOCK_START` adds hard breaks before lines like `<3`] → that is the intended fix; the hard break is
  valid CommonMark.
- [Block starts are broader than CommonMark: an ordered item not starting at 1, or an inline tag such as `<b>`,
  cannot interrupt a paragraph there, but ends a group here] → a span that crosses such a line is split, and its
  `<` may get a stray `\`. Documented, not fixed.
- [Trailing whitespace inside a multi-line span is stripped; CommonMark keeps it] → the span text may lose those
  spaces. Documented, not fixed.
- [A definition whose destination is on the next line, followed by another definition] → the later `<` is
  escaped, because only `[label]:` lines count as definition lines. Documented, not fixed.
