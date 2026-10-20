# Tasks

## 1. Block-marker lines take no hard break

- [x] 1.1 Add failing tests in `tests/reddit-bodies.test.ts` for the "Block-marker lines take no hard break"
  scenarios (`*  \nbar`, `1.  \nbar`, `# h  \nbar`, `---  \nbar`, `a\n===  \nbar`, `>  \nbar`, plus the
  mid-paragraph `a\n*  \nbar` that must keep `*\`); verify `bun test` fails on the new cases only
- [x] 1.2 Add `noBreakLine` in `src/normalize.ts` and call it at both break sites in `normalizeGroup` (the
  single-line path and the multi-line loop); the empty-item case applies only to the first line of a group;
  verify `bun test` passes

## 2. Closing tags are escaped

- [x] 2.1 Add failing tests for the "Closing HTML tags" scenarios (`</div>`, `a </b> c`, `` `</div>` ``, `1 </ 2`,
  `a </3`, `<!-- c -->` unchanged) and update the existing `a  \n</div>` expectation to `a\n\</div>`; verify
  `bun test` fails on the new cases only
- [x] 2.2 Change the `fixProse` lookahead to `(?=[A-Za-z]|\/[A-Za-z])`; verify `bun test` passes, including the
  definition-destination, link-destination and autolink tests

## 3. Hard break before an ordered item not starting at 1

- [x] 3.1 Add failing tests: `a  \n2. b` and `a  \n01) b` give `a\` then the item; `a  \n1. b` gives no `\`;
  `1. a  \n2. b` and `- a\n\n  b  \n2. c` give no `\`; `> a  \n> 2. b` is unchanged from today; verify
  `bun test` fails on the first case only
- [x] 3.2 Make the ordered alternative of `BLOCK_START` `1[.)]` (merge it with `INTERRUPT`), add the `inList`
  flag in `normalizeBody` and `normalizeGroup`, and restore the old any-ordered-item block while `inList` is true;
  verify `bun test` passes
- [x] 3.3 Update the `normalizeBody` doc comment: remove the "ordered item not starting at 1" limit and describe
  the list exception; verify `bun run typecheck` and `bun run lint:code` pass

## 4. Indented code inside quotes

- [x] 4.1 Add tests: `> a`, `>`, then `>` plus five spaces and `<b>` with trailing spaces stays unchanged (fails now); `>     <b>` nested as `> >     <b>`
  and `> - a\n>\n>       <b>` stay unchanged (fail now); `>    <b>` (four spaces) becomes `>    \<b>`; the list case
  `- a`, a blank line, then six spaces and `<b>` with trailing spaces stays unchanged (passes now, regression test); a quoted image-URL line inside quoted
  indented code is kept by the Reddit adapter; verify `bun test` fails on the quote cases only
- [x] 4.2 Add `quotedIndent` (linear loop) and use it next to `INDENTED` in `scanCode`; update the `scanCode`
  doc comment (quote-aware, list case already covered, the remaining trade-offs); verify `bun test`,
  `bun run typecheck` and `bun run lint:code` pass

## 5. Integration

- [x] 5.1 Add timing tests or run a script on 40k-char inputs (many `</`, many `>` markers, many empty-bullet lines with trailing spaces),
  each under 100 ms; verify they pass
- [x] 5.2 Update the `normalizeBody` doc comment so it lists only the limits that remain (closing-tag-only
  escaping, comment and CDATA openers unescaped, quoted lines never take a hard break, list indent 4+ is code);
  run `bun run verify` (includes `schemas:check`, so `examples/` must be unchanged); verify
  `openspec validate normalize-followups --strict` passes

## Workflow follow-up

- Review with the `reviewer` agent, commit as `fix(normalize): ...`, then archive the change.
