# Design: v2 Standard Exports

## D1. Tooling (mirror `../claude-code-docs`)

- `package.json`: private, `packageManager: bun@1.4.3`, devDeps `typescript ^7.0.2`, `@biomejs/biome 2.5.15`, `@types/bun`,
  `@types/chrome`, `lefthook`, `@commitlint/cli` + `config-conventional`, `markdownlint-cli2`, `ajv` + `ajv-formats`, `happy-dom`.
  No runtime dependencies.
- Copy `biome.json`, `bunfig.toml`, `.bun-version`, `commitlint.config.mjs`, `.markdownlint.jsonc`, `tools/install-hooks.sh` verbatim;
  `tsconfig.json` same strict flags, `types: ["bun", "chrome"]`, no docusaurus types/paths. `lefthook.yml` with the same jobs
  minus docs-site jobs. Scripts: `build`, `typecheck` (`bun --check`), `format`, `format:check`, `lint:code`, `lint`, `test`,
  `schemas:check`, `verify` (all gates + build + test).
- Layout: `src/` (TS), `src/adapters/`, `static/` (manifest, html, css), `schemas/`, `tests/`, `dist/` (built, gitignored,
  load unpacked from here). `bun build` entrypoints: `background.ts`, `popup.ts` (popup + Advanced), `content.ts` (IIFE, injected
  with `scripting.executeScript({files})`, not `func`).

## D2. Document Model

One `ExportDocument { meta, blocks }`, built by adapters, serialized twice. Blocks: heading, paragraph, list/item, quote, code,
table, media (image/video/audio/embed), term/definition, control, post, comment, answer (Stack Exchange), link.
IDs: adapter-native when stable (`t1_…`, HN item id, GitHub comment id, SE post id), else capture-local `b1…`.
`meta`: url, canonical, title, description, language (BCP 47), captured_at (RFC 3339 UTC), adapter, scope, site, author/published
(from JSON-LD), coverage, warnings, `content_trust: "untrusted"`.

## D3. Markdown Serializer (default)

CommonMark + GFM tables. YAML front matter (`title`, `url`, `canonical`, `captured_at`, `adapter`, `language`, `coverage`,
`content_trust`, `warnings` when non-empty), then llms.txt layout: `# Title`, `> description`, body. Threads: each post/comment/answer is a heading-free
block `**author** · score · date · id` with reply nesting as nested blockquote levels capped at depth 6, deeper replies flattened
with an explicit `reply to <id>`. Native Markdown bodies (Reddit, GitHub, SE source) pass through; code fences sized to never
collide with content backticks. Media as links. Output passes markdownlint core rules where content allows, with one
intended exception: MD025 counts the front-matter `title` and the `# Title` heading as two top-level titles. Both stay
(agents that skip front matter still see the title); `examples/*.md` disable MD025 for this reason.

## D4. JSONL Serializer

JSON Lines, LF, UTF-8. Line 1 header: `{"$schema": "<schema URL>", "type": "document", ...meta}`. Schema at
`schemas/page-export.schema.json` (draft 2020-12, `oneOf` on `type`), `$id`
`https://raw.githubusercontent.com/xsyetopz/export-for-ai-agents/main/schemas/page-export.schema.json`. snake_case keys.
`bun run schemas:check` validates every fixture output and `examples/` with ajv.

## D5. Naming

Filename `<host>-<path-slug>-<YYYYMMDDTHHMMSSZ>.<md|jsonl>` (ISO 8601 basic UTC, lowercase ASCII slug ≤ 60 chars, `www.` dropped).
MIME `text/markdown;charset=utf-8` (RFC 7763) and `application/jsonl`.

## D6. Adapters

Interface `{ id, matches(url): boolean, capture(ctx): Promise<ExportDocument> }`; first match wins, generic last.
- generic: main-content DOM extraction + `application/ld+json` (schema.org Article/DiscussionForumPosting/QAPage) metadata.
- reddit: port v1 (same-origin JSON, trim in tab, gate, 429 + Retry-After, cache, morechildren batches, coverage).
- hackernews: `news.ycombinator.com/item?id=` DOM (`tr.athing.comtr`, `td.ind[indent]`, `.commtext`), parent from indent.
- github: issues/PRs/discussions DOM (title, body, timeline comments, authors, dates); repo/file pages via generic `.markdown-body`.
- stackexchange: SE family hosts; question, answers (score, accepted), comments, tags; DOM only.
Site adapters fall back to generic only on structural "not this layout" errors, never on rate limit/busy/timeout.

## D7. Performance (from audit)

- Single-pass DOM walk with `TreeWalker`; one traversal per subtree (text, links, media gathered together); count every node;
  `el.checkVisibility()` instead of `getComputedStyle` + ancestor climbing; time-slice (yield every ~8 ms) so the tab stays responsive.
- Inject a bundled file once; message results; abort in-tab work on timeout via a token.
- Reddit errors: 429/busy/cooldown show `retry at` in UI; no DOM fallback.
- Preview: render at most the first 200,000 characters; copy/save use the full text. Serialize once per option change, debounced.
- Cache: keep only the trimmed JSON, size-capped; byte count via a length loop, not `TextEncoder` copy.

## D8. Bugs to Fix

SVG tagName case; stale output when options change during a capture (queue latest request); inline wrappers containing blocks
flattened; selection scope missing shadow DOM and duplicate links; `closest()` across shadow roots; unused `retryAt`.

## D9. UI

Popup: format toggle (Markdown | JSONL), Copy, Save, Refresh, coverage line, Advanced…. Advanced: preview, scope, budget,
adapter options (Reddit sort/more comments). Settings in `chrome.storage.local`, debounced.
