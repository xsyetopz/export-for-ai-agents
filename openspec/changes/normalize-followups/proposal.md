# Proposal

## Why

The previous change (`normalize-lows`, archived) left four gaps in the Reddit body normalizer
(`src/normalize.ts`), listed as approximations in its code comments. Each one still corrupts exported Markdown
in an edge case: a stray `\` inside a heading or list marker, a closing tag that starts an HTML block, a lost
hard break, and code inside a quote that is rewritten as prose.

## What Changes

- A line that is itself a block marker (an empty list item such as `*`, an ATX heading, a thematic break, a
  setext underline, or a bare `>`) no longer gets a `\` hard break. `*` plus two trailing spaces, then `bar`, stays `*`, not `*\`.
- A closing tag such as `</div>` has its `<` escaped like an opening tag, so it can no longer start an HTML block
  under a raw-HTML renderer. Comments, processing instructions, declarations and CDATA stay as they are.
- A hard break is now kept before an ordered item that does not start at 1 (`a` plus two trailing spaces, then `2. b`), since that line
  is paragraph continuation text. Inside a list item the break is still skipped, because there the next item is a
  sibling and a `\` would show as a literal backslash.
- Indented code inside a block quote (`>` plus an optional space plus four spaces) is detected as code and left
  untouched. Indented code inside list items is already detected (any line indented 4+ columns is code); this is
  pinned with a regression test, not changed.
- The `normalizeBody` and `scanCode` doc comments drop the limits that are fixed and keep the ones that remain.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `body-normalization`: hard-break rules (block-marker lines, ordered items not starting at 1), `<` escaping of
  closing tags, and code detection inside quotes.

## Impact

- Code: `src/normalize.ts` (`normalizeGroup`, `normalizeBody`, `BLOCK_START`, `fixProse`, `scanCode`, and the
  doc comments).
- Tests: `tests/reddit-bodies.test.ts`. The existing `a  \n</div>` expectation changes to the escaped form.
- Output: Reddit exports change only in the edge cases above. No schema or format change; `examples/` should not
  change (check with `bun run schemas:check`). `dropImageUrlLines` in `src/adapters/reddit.ts` also uses
  `scanCode`, so it also sees the new quoted-indented-code mask, which has no effect there: its regexes never match lines starting with `>` (the test is a regression guard only).
