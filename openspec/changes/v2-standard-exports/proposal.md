# Proposal: v2 Standard Exports

## Why

User: "You can take lessons from the `xsyetop/claude-code-docs` locally, but also convert this to a proper standardised
jsonl/markdown-based exporting for various websites in a way specifically for AI agents to skim through."
"the current `export--` naming is also bad. we prefer standardised/open standards for such."
"Now, same tpyescript 7.0.2 and biome settings, much for other settings, too."
"This was originally made by GPT, so if you can see bad code, fix it, okay?"
"This extension also has massive lag issues."

User choices: adapters = Reddit (keep), Hacker News, GitHub, Stack Exchange. Default popup format = Markdown.

## What Changes

- Rewrite in TypeScript (`typescript ^7.0.2`), Bun `1.4.3`, Biome `2.5.15` with the claude-code-docs `biome.json`,
  same strict `tsconfig.json`, lefthook, commitlint (Conventional Commits), markdownlint, openspec. Built with `bun build` into `dist/`.
- One internal document model; two serializers:
  - **Markdown**: CommonMark/GFM with YAML front matter, laid out like llms.txt (H1 title, blockquote summary, sections).
  - **JSONL**: JSON Lines (`application/jsonl`), every record validated by a published JSON Schema (draft 2020-12),
    referenced by `$schema` URL in the header record. Replaces the ad-hoc `schema: "export-for-ai-agents/1"`.
- Standard naming: files `<host>-<path-slug>-<ISO 8601 basic UTC>.md|.jsonl` (no `export-` prefix);
  RFC 3339 timestamps, BCP 47 language tags, absolute WHATWG URLs, schema.org JSON-LD metadata where pages provide it.
- Site adapters behind one interface: generic page (main content + JSON-LD), Reddit, Hacker News, GitHub, Stack Exchange.
- Fix the lag (see design D7) and the bugs found in the audit.
- Repo docs: `CLAUDE.md`/`AGENTS.md`, README, `docs/FORMAT.md` rewritten for v2.

## Out of Scope

Crawling, auto-scrolling, pagination, persistent host permissions, telemetry, AI summarisation, Chrome Web Store publishing.
