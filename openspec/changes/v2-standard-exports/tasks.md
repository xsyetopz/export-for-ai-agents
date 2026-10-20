# Tasks: v2 Standard Exports

- [x] 1.1 Tooling and layout (D1): package.json, configs, bun install, build skeleton, gates green
- [x] 1.2 Document model, Markdown + JSONL serializers, JSON Schema, naming (D2-D5); unit tests
- [x] 1.3 Generic adapter: fast single-pass DOM capture + JSON-LD (D6, D7, D8); happy-dom tests
- [x] 1.4 Reddit adapter port + background gate (D6, D7); tests
- [x] 1.5 Hacker News, GitHub, Stack Exchange adapters (D6); fixture tests
- [x] 1.6 Popup + Advanced UI (D9); tests
- [x] 1.7 Docs: README, docs/FORMAT.md, CLAUDE.md/AGENTS.md, examples; remove v1 files; verify; review
  - v1 removal done early: `extension/`, `tests/*.mjs`, `tests/fixtures/reddit.mjs`, `examples/reddit.jsonl` are deleted; schema is `schemas/page-export.schema.json`, fixtures in `tests/fixtures/`. Remaining: docs, examples, review.

## 2. Fixes from manual Chrome testing

- [x] 2.1 Popup palette: replace ultramarine with a neutral graphite palette (no purple/blue); update DESIGN.md tokens and prose
- [x] 2.2 Reddit export cleanup: post title duplicated and glued to the meta line in Markdown; bare image URL duplicated next to its image; whitespace-only lines and trailing spaces in bodies; Markdown front matter missing `scope`/`site`
- [x] 2.3 Review fixes: Reddit `partial` no longer set by `num_comments` exceeding captured alone (only known-missing content); FORMAT.md media wording matches the Reddit `![alt](url)` image references
- [x] 2.4 Normalize low findings: strip trailing NBSP/zero-width space; resolve relative Reddit links to https://www.reddit.com; escape `<` before a letter outside code; no `\` hard break before a fence, heading or quote
