# Design

## Context

See proposal.md for the four gaps. In `src/normalize.ts`, `normalizeBody` splits the text into paragraph groups
(`startsGroup`) and calls `normalizeGroup` on each. `normalizeGroup` adds the `\` hard break (two paths: a
single-line fast path and a multi-line path with code-span tracking) unless the next line matches `BLOCK_START`.
`fixProse` escapes `<` before a letter. `scanCode` marks fenced and indented code lines in a mask that
`normalizeBody` copies through untouched. All scans must stay linear (40k-char inputs under 100 ms, loose enough for loaded machines but far below quadratic growth).

## Goals / Non-Goals

**Goals:** fix the four gaps with the smallest change to each function; keep every scan linear.

**Non-Goals:** a real CommonMark block parser. Container state (lists, quotes) stays approximated. Escaping
comments, processing instructions, declarations or CDATA is out: existing tests pin them unescaped.

## Decisions

### Gap 1: `*  \nbar` becomes `*\`

Confirmed. `normalizeGroup` treats a one-line group like any other and appends `\` when the next line is
non-blank and not a block start. The same happens to `# h  \nbar`, `---  \nbar`, `a\n===  \nbar` and `>  \nbar`
(probed), so the fix covers all of them, not only the list marker.

- Add `noBreakLine(trimmed, atGroupStart)`: true for an ATX heading (`ATX`), a thematic break, a setext underline
  (`[=-]+`), a quote-only line (`QUOTE_ONLY`), or, only when `atGroupStart`, an empty list item
  (`^ {0,3}(?:[-+*]|\d{1,9}[.)])$`). The same markers also count after container prefixes: a leading `^ {0,3}(?:>[ \t]?)*`
  and then at most one list marker `(?:[-+*]|\d{1,9}[.)])[ \t]+` (which needs content after it, so a bare `-` or
  `---` is classified as before) are stripped and ATX, thematic break and empty item are tested on the rest; a setext
  underline is not tested after a list marker (`- ===` is item text). Both break sites in `normalizeGroup` call it
  and skip the `\`.
- The empty-item case is limited to the first line of a group on purpose. Mid-paragraph, `*` cannot interrupt, so
  `a\n*  \nbar` is the text `*` inside a paragraph and the existing spec scenario ("Empty list item keeps the hard
  break") keeps its `*\`. The first line of a group is the only place where the item can open a block.
- Alternative: handle only single-line groups. Rejected: `# h` inside a multi-line group cannot happen (a heading
  is its own group), but `===` and `---` underlines do sit mid-group.

### Gap 2: closing tags are not escaped

Confirmed. `fixProse` escapes `<` only when followed by `[A-Za-z]`, so `</div>` passes through. `BLOCK_START` and
`INTERRUPT` already treat `</div>` as an HTML block start (`\/?` in `HTML_OPEN`), so the line really does start a
type-6 block under a raw-HTML renderer.

- Change the lookahead in `fixProse` to `(?=[A-Za-z]|\/[A-Za-z])`. The existing guards (odd backslash count, `keep`
  set for definition destinations, the `](` destination check, the autolink scheme check) apply unchanged.
- Closing tags outside code spans anywhere in prose are escaped, including inline (`a </b> c`). That matches how
  `<b>` is handled now and the output is only read as Markdown, so literal `</b>` text is acceptable.
- Not escaped, by decision: `<!--`, `<?`, `<!X` and `<![CDATA[`. The tests at `a  \n<!-- c -->`, `<?php`,
  `<![CDATA[` and `<!DOCTYPE` assert them unescaped, and the task named only closing tags. Recorded as a
  remaining approximation.
- `a  \n</div>` stays without a hard break, as for `<div>` today (the line is still treated as a block start for
  breaks); only its text changes to `\</div>`. The existing test for it is updated.
- Alternative: escape any `<` followed by `/`. Rejected: `a </3` and `1 </ 2` are plain text.

### Gap 3: hard break skipped before an ordered item not starting at 1

Real, and the fix is to keep the break, with one exception.

- CommonMark: an ordered list can interrupt a paragraph only if it starts at 1 (and is non-empty). `a  \n2. b` is
  one paragraph with a hard break, so the right output is `a\` then `2. b`. Today `BLOCK_START` uses `\d{1,9}`, so
  the break is lost. Setting its ordered alternative to `1[.)]` makes `BLOCK_START` equal to `INTERRUPT`, so the
  separate constant is dropped and one regex remains.
- Exception, which makes this more than a regex edit: a paragraph inside a list item, followed by the next
  sibling item (`1. a  \n2. b`, very common in Reddit text). The next item is not a continuation there, so a `\`
  at the end of that paragraph would render as a literal backslash. So the break is still skipped before an
  ordered item when the group is inside a list.
- Track list context in `normalizeBody` as a boolean `inList` passed to `normalizeGroup`: set when a group's first
  line is a list item (`LIST_ITEM` has no `>` handling; harmless, since quoted lines never take breaks); cleared when a group's first line has no indent and is not a list
  item; unchanged for an indented first line. A group that begins with a list item keeps `inList` for its later
  lines. When `inList` is true, `normalizeGroup` uses the old behaviour (any ordered item blocks the break).
- Why a flag and not nothing: the failure of a wrong break (literal backslash in the text) is worse than the
  failure of a missed break (soft break), so the flag errs towards skipping.
- Alternative: just narrow the regex. Rejected: it turns `1. a  \n2. b` into `1. a\` / `2. b`.
- `> a  \n> 2. b` is not touched: the next line starts with `>`, which is a block start for breaks, so quoted
  lines never get a break. Known, separate, and not changed here.

### Gap 4: indented code inside list and quote containers

Partly real. `scanCode` marks any non-blank line with 4+ leading spaces or a tab as code, with no container
awareness. Probed:

- Lists: already covered. Code in a list item sits at content offset + 4, always 4+ absolute columns, so it is
  masked (`- a\n\n      <b>` stays unchanged). Descoped; a regression test pins it.
- Quotes: a real gap. `>     <b>` has its `<` escaped and trailing spaces cut, because the line starts with `>`,
  not with spaces.
- Fix in `scanCode`: add a manual loop `quotedIndent(raw)`: skip leading spaces and tabs, then repeat: consume
  `>`, consume one optional space, and if the next non-space character is another `>` continue. After the last
  marker, the line is code if the remainder has 4+ spaces before its first non-space character, or starts with a
  tab not directly after `>`. The line must have non-whitespace content after that. This replaces the `INDENTED`
  test in the mask loop (`INDENTED.test(raw) || quotedIndent(raw)`) and sets `indented[i]` so the existing blank
  bridging applies. A loop, not a backtracking regex: `(?:>[ ]?)+ {4}` would match `>    x` (four spaces) by
  giving back the optional space. The loop is linear.
- Tab handling is approximate: `>\tx` is not code (the tab is partly eaten by the optional space), `>\t\tx` is.
- Decision kept from `scanCode`: a quoted line indented 4+ is code even right after a quoted paragraph line,
  where CommonMark reads it as continuation. Same trade-off as at top level (false "code" leaves a `<` unescaped
  and the whitespace unstripped; the opposite error would damage code).
- No effect on `dropImageUrlLines` (`src/adapters/reddit.ts`): it never matches quoted lines, so the quoted
  image-URL test is a regression guard only.
- Not fixed: bare `>` lines between two quoted code lines are not bridged into the mask. Normalizing a `>` line
  only trims it, so nothing visible changes.
- Not fixed: a nested list indented 4+ columns (for example `- a` then an indented `- b`) is read as code and is not
  normalized. That is the same trade-off, it needs a block parser, and it is not in this change.

## Risks / Trade-offs

- [`inList` heuristic wrong, for example an unindented paragraph after a list with no blank line] → such a line is a
  lazy continuation inside the same group, so the state is unchanged and the old behaviour (break skipped) is kept.
  Worst case is a missed hard break, as today.
- [Escaping `</x>` changes exports that contain closing tags in prose] → intended; matches `<x>`. Only Reddit
  bodies that contain closing tags change.
- [`quotedIndent` false positive on quoted paragraph continuation] → documented trade-off above.
- [Gap 1 widens beyond the stated example] → limited to lines that cannot carry a hard break; tests cover each.
- [Linear time] → `noBreakLine` and `quotedIndent` are bounded per line; add the 40k-char timing check from
  `normalize-lows`, plus 40k chars of `>` markers and of `</`.

## Assumptions

- Reddit input only; other adapters do not call `normalizeBody` with quotes or lists in a way that changes.
- `examples/` has no case that hits these paths, so `bun run schemas:check` should pass unchanged. If it does
  not, regenerate with `bun run examples` and inspect the diff.
