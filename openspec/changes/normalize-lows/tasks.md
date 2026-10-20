# Tasks

## 1. Normalizer fixes

- [x] 1.1 In `codeSpans` (`src/normalize.ts`), treat an escaped run of 2+ backticks as an opener at `pos + 1`,
  `len - 1`; add tests in `tests/reddit-bodies.test.ts` for both "Escaped backtick runs" scenarios; verify
  `bun test` passes
- [x] 1.2 Narrow the `<` alternative in `BLOCK_START` to `<[A-Za-z/!?]`; add tests for both "Only HTML-like
  lines block a hard break" scenarios; verify `bun test` passes
- [x] 1.3 In `fixProse`, skip escaping when `](` plus optional spaces/tabs precede `<` (linear backward scan);
  add tests for both "Link destinations" scenarios plus a tab case; verify `bun test` passes
- [x] 1.4 In `normalizeBody`, group consecutive prose lines into paragraphs and run the code-span and `<` scans
  over each group (lines joined with `\n`), so a span can cross lines. End a group at a blank line, a line of
  only `>` quote markers, a code line, or a `BLOCK_START` line; a `>` line continues only after a `>` line; an
  ATX heading is its own group. Add no `\` hard break at a line end inside a span. Let the link-destination
  scan cross one line break. Add tests for the "Code spans may cross lines" scenarios, the newline "Link
  destinations" scenario and the "Escaped run closes at full length" scenario; verify `bun test` passes
- [x] 1.5 Skip escaping the `<` that opens a link reference definition destination (`[label]:`, optional
  spaces/tabs and at most one line break, then `<`). Recognise it only at a group start or right after another
  definition line, with optional `>` prefixes and up to 3 spaces of indent, using a bounded regex. Add tests for
  the four "Reference definition" scenarios; verify `bun test` passes
- [x] 1.6 Update the `normalizeBody` doc comment: drop the two fixed limits and state the remaining
  approximations (block-start breadth, trailing whitespace in spans, definition lines after a non-definition
  line); verify `bun run typecheck` and `bun run lint:code` pass

## 2. Integration

- [x] 2.1 Run `bun run verify` (includes `schemas:check`, so `examples/` must be unchanged) and 40k-char timing
  checks for `normalizeBody`, each under 5 ms: many `<` with whitespace runs, and one 40k-char paragraph with
  many lines and backtick runs; verify all pass

## 3. Remaining LOW findings

- [x] 3.1 Make `opensDestination` respect the group start, so a `[x]:` line that is not a definition (e.g.
  `foo\n[x]:  \nbar`) keeps its `\` hard break; add a test; verify `bun test` passes
- [x] 3.2 Keep the hard break before a `<letter` line that is not an HTML block start (only CommonMark HTML
  types 1-7 openers block it); add tests; verify `bun test` passes
- [x] 3.3 Add tests for `<DIV>` (case-insensitive HTML start), `1.` vs `01)` / `2.` paragraph interruption, and
  CDATA / doctype lines; verify `bun test` passes
- [x] 3.4 Add spec scenarios for 3.1-3.3 in `specs/body-normalization/spec.md`, update the `normalizeBody` doc
  comment, run `bun run verify` and the 40k-char timing checks (each under 5 ms); verify
  `openspec validate normalize-lows --strict` passes
- [x] 3.5 Make the CDATA opener case-sensitive and stop empty list items (marker with only whitespace after
  it) from counting as paragraph interrupters or hard-break blockers; add tests and spec scenarios; verify
  `bun run verify` passes

## Workflow follow-up

- Review with the `reviewer` agent, commit as `fix(normalize): ...`, then archive the change.
