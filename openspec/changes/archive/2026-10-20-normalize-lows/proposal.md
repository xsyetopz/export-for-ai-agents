# Proposal

## Why

The v2 review left four low findings in the Reddit body normalizer (`src/normalize.ts`). Three can corrupt
exported Markdown in edge cases (a stray `\` inside code, a lost hard break, a broken link target); the fourth
is two limits that were undocumented: code spans across lines, and reference-style link definitions. Both are
now fixed rather than documented. They are cheap to fix now while the code is fresh.

## What Changes

- An escaped backtick run longer than one backtick (``\`` `` ` ``) still opens a code span with the rest of the
  run, so `<` inside that span is no longer escaped.
- A line starting with `<` only blocks the preceding hard break when it looks like an HTML tag
  (`<` then a letter, `/`, `!` or `?`). `<3 you` keeps the hard break.
- `<` in a link destination stays unescaped when spaces, tabs or one line break sit between `](` and `<`.
- Code spans can cross line breaks inside a paragraph. A paragraph ends at a blank line, a code line, or a line
  that starts a new block (list item, heading, thematic break, fence, HTML-like line, setext underline). No `\`
  hard break is added at a line end inside a span.
- `<` that opens the destination of a link reference definition (`[x]: <y>`) stays unescaped.
- The `normalizeBody` doc comment lists only the limits that remain.

## Capabilities

### New Capabilities

- `body-normalization`: how adapter-produced Markdown bodies are cleaned (whitespace, hard breaks, `<` escaping,
  relative links) while code stays untouched.

### Modified Capabilities

None.

## Impact

- Code: `src/normalize.ts` (`codeSpans`, `BLOCK_START`, `fixProse`, and `normalizeBody` for paragraph groups,
  reference definitions and the doc comment).
- Tests: `tests/reddit-bodies.test.ts`.
- Output: Reddit exports change only in the edge cases above. No schema or format change; `examples/` should
  not change (check with `bun run schemas:check`).
