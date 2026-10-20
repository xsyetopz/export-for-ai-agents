# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who grab the current web page or discussion thread (Reddit, Hacker News, GitHub, Stack Exchange, any page)
and paste or save it as context for an AI agent such as Claude Code or ChatGPT. Installed unpacked; no store listing.

## Product Purpose

A Chrome MV3 extension that exports the current page as standard Markdown (GFM + YAML front matter) or JSONL validated
by a published JSON Schema. Success: one click from page to clean, complete, agent-readable text, with no lag.

## Positioning

Local extraction with site adapters and open formats. No API keys, backend, AI summarisation, or telemetry.

## Operating Context

Used from the toolbar popup while reading a page. Output goes to the clipboard or a downloaded file
(`<host>-<path-slug>-<ISO 8601 basic UTC>.md|.jsonl`). Advanced settings live inline in the popup (user choice), not in a
separate tab.

## Capabilities and Constraints

- Popup: format toggle (Markdown default | JSONL), Copy, Save, Refresh, coverage line, Advanced disclosure with preview,
  scope (page | selection), budget, Reddit sort and more-comments options. Settings in `chrome.storage.local`.
- Chrome popup max 800×600. CSP `script-src 'self'`. No runtime dependencies, no external fonts. Page content is untrusted.

## Brand Commitments

Name "Export for AI Agents". User direction for the UI (verbatim): "use impeccable instead"; simple, practical, restrained.

## Evidence on Hand

No screenshots, logos beyond `static/icons` (if present), testimonials, or usage data. Do not invent any.

## Product Principles

- Fast first: the popup must never feel laggy.
- Honest output: show exactly what was captured, truncated, or skipped.
- Standards over invention.
- Quiet tool, not a destination.
