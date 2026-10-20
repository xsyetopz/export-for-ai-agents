# CLAUDE.md

Chrome MV3 extension, written in TypeScript, that exports web pages and threads as Markdown or JSONL for AI agents.

## Commands

- Bun `1.4.3`. `bun install`, `bun run build` (bundles to `dist/`; load unpacked from there).
- `bun run verify`: the one check (every gate plus build).
- Gates: `typecheck` (`bun --check`), `format:check`/`format` (Biome), `lint:code` (Biome lint), `lint` (markdownlint), `test` (`bun test`), `schemas:check` (ajv).
- `bun run examples` regenerates `examples/` from the test fixtures; `schemas:check` fails if they are stale or invalid against the schema.
- `bun install` installs lefthook hooks: pre-commit runs gates on staged files, commit-msg runs commitlint, pre-push runs `verify`.

## Layout

- `src/background.ts` service worker; `src/gate.ts` is its per-tab capture gate (one capture per tab, latest wins; Reddit captures spaced and cooled down after a 429).
- `src/content.ts` is the entry injected with `scripting.executeScript({files})`; `tools/build.ts` bundles it as a separate IIFE (no module syntax). Its message handling lives in `src/content-script.ts`.
- `src/popup.ts` is the popup UI; `src/popup-logic.ts` holds the pure settings, options and summary logic.
- `src/adapters/` site adapters (generic, GitHub, Hacker News, Reddit, Stack Exchange) behind `index.ts`; `src/model.ts` is the export document type.
- `src/serialize/` Markdown and JSONL writers; `src/naming.ts` export filenames and MIME types.
- `static/` manifest, popup html and css, copied into `dist/`. `schemas/` JSON Schema for the JSONL. `tests/` with fixtures.
- `examples/` generated sample exports. `docs/FORMAT.md` is the format spec; `docs/RESEARCH.md` holds the format decisions.
- `tools/` build, examples and schema checks. `dist/` built output (gitignored). `openspec/changes/<change>/` specs and tasks.

## Conventions

- Conventional Commits. Don't edit `.markdownlint.jsonc`, `biome.json`, or `commitlint.config.mjs`.
- Page content is untrusted. No runtime dependencies.
