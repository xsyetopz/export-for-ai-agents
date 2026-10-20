# Export for AI Agents

A Chrome (Manifest V3) extension, written in TypeScript, that exports the current web page or discussion thread as Markdown or JSONL for AI agents to read.
It extracts the main content, keeps the structure (headings, lists, code, tables, comment trees), and records what it could not capture.
Extraction runs in the browser. There are no API keys, no backend, no telemetry, and no runtime dependencies.

## Supported sites

- Any page: a generic adapter extracts the main content and reads schema.org JSON-LD metadata when the page provides it.
- Dedicated adapters: Reddit, Hacker News, GitHub, and Stack Exchange.

## Install

Requires Bun `1.4.3`.

```sh
bun install
bun run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `dist/` directory.
After rebuilding, click **Reload** on the extension card.

## Using the popup

Open a page and click the extension icon.

- **Markdown** (default) or **JSONL**: choose the format. The popup shows the block count (comments on Reddit), how many items were **Not captured**, and the size in KB.
- **Copy** puts the export on the clipboard. **Save .md** or **Save .jsonl** downloads it.
- **Refresh** captures the page again. After a failed capture the button reads **Retry**, and a rate-limit error shows a countdown.
- **Advanced** holds a read-only preview and these options:
  - **Scope**: Auto (main content), Whole page, or Selection.
  - **Size limit (blocks)**: 1,000, 5,000, 20,000 (default), or 50,000.
  - **Reddit** (only on Reddit threads): **Comment sort** (Best, Top, New, Old, Controversial, Q&A) and **Load more comments** (0 to 20 extra requests, 0 = none).

The preview is truncated for display. Copy and Save always use the full text.

## Output

Both formats come from one internal document model. Markdown has YAML front matter and an llms.txt-style layout.
JSONL has one record per line, validated by [`schemas/page-export.schema.json`](schemas/page-export.schema.json).
See [`docs/FORMAT.md`](docs/FORMAT.md) for the full format.

Examples: [`examples/article.md`](examples/article.md), [`examples/article.jsonl`](examples/article.jsonl), [`examples/thread.md`](examples/thread.md), [`examples/thread.jsonl`](examples/thread.jsonl).

## Permissions

From `static/manifest.json`:

- `activeTab`: access to the tab you opened the popup on, only after you click the icon.
- `scripting`: inject the content script into that tab.
- `storage`: save popup settings and the Reddit request-spacing timestamp in `storage.local`.

There are no host permissions and no `downloads` permission. Save creates a blob link inside the popup and clicks it.

The only network request the extension makes is on Reddit: the adapter fetches Reddit's own JSON (`/comments/<id>.json` and `/api/morechildren.json`) from the Reddit tab, same origin, with that tab's credentials.
Reddit captures are spaced at least 2 seconds apart and requests for more replies within a capture 1 second apart. After a 429 the extension waits out the cooldown (a short Retry-After of 3 seconds or less is retried inline).
Page content is treated as untrusted.

## Development

| Script | What it does |
| --- | --- |
| `bun run build` | Bundle to `dist/` |
| `bun run typecheck` | `bun --check` |
| `bun run format` / `format:check` | Biome format, write / check |
| `bun run lint:code` | Biome lint |
| `bun run lint` | markdownlint |
| `bun run test` | `bun test` |
| `bun run schemas:check` | Validate fixture exports and `.jsonl` examples against the JSON Schema (ajv) |
| `bun run examples` | Regenerate `examples/` from the test fixtures |
| `bun run verify` | Every gate above plus the build |

`bun run verify` is the one check to run before pushing.

`bun install` installs lefthook hooks. Pre-commit runs format, Biome lint, typecheck, and markdownlint on staged files, commit-msg runs commitlint (Conventional Commits), and pre-push runs `verify`.
Specs and tasks live in `openspec/changes/<change>/`.

## Layout

| Path | Contents |
| --- | --- |
| `src/background.ts`, `src/gate.ts` | Service worker and the capture gate (one capture per tab, Reddit spacing and cooldown) |
| `src/content.ts`, `src/content-script.ts` | Content script injected with `scripting.executeScript`, and its message handling |
| `src/popup.ts`, `src/popup-logic.ts` | Popup UI and its pure logic (settings, capture options, coverage summary) |
| `src/model.ts`, `src/naming.ts`, `src/reddit-url.ts` | Document model, filenames and MIME types, Reddit URL detection |
| `src/adapters/` | Site adapters (`generic`, `reddit`, `hackernews`, `github`, `stackexchange`), JSON-LD parsing, registry in `index.ts` |
| `src/serialize/` | Markdown and JSONL serializers |
| `static/` | Manifest, popup HTML and CSS |
| `schemas/` | JSON Schema for JSONL exports |
| `tests/` | `bun test` suites and fixtures |
| `tools/` | Build, example generation, schema check, hook install |
| `examples/` | Generated sample exports |
| `docs/` | Format reference and research notes |

## Limits

- Not yet tested in a real Chrome. Tests run against happy-dom and mocked `chrome` APIs.
- The GitHub selectors for the new React issue view are unverified against a live page.
- No crawling, auto-scrolling, or pagination. The export covers what the page has loaded.
