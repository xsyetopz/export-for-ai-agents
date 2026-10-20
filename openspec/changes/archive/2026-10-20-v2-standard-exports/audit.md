# Audit of v1 (reviewer, 2026-10-20)

Paths refer to v1 `extension/`. All 19 v1 tests passed. Not browser-profiled.

## Lag causes (ranked)
1. DOM capture is synchronous on the page main thread and not truly bounded: 100k limit counts only `walk()` calls (capture.mjs:99); `plain()`/`links()`/`nestedMedia()`/`querySelectorAll` re-walk each block 3-4x (:35-58, :65, :91, :183-185); `[...childNodes]` copies per level (:33); first `getComputedStyle` (:18) forces style recalc and `hidden()` climbs ancestors.
2. Any Reddit error (incl. 429 cooldown, busy, timeout) falls back to heavy shreddit DOM capture (export.mjs:82, background.mjs:53,63).
3. Advanced preview textarea gets full multi-MB JSONL with `white-space: pre` on every option change (export.mjs:32, export.css:35).
4. Every popup open captures; Reddit path is popup->worker->executeScript, JSON parsed/stringified/copied 3 times (export.mjs:57); multi-MB string written to storage.session per fetch (background.mjs:35).
5. Minor: TextEncoder copy just to count bytes (format.mjs:72); JSON.stringify per link to dedupe (capture.mjs:170).

## Bugs
- SVG tagName is lowercase 'svg'; branch never matches (capture.mjs:107, :179).
- capture() returns early when busy; option changes during capture never applied (export.mjs:60, :131).
- Inline wrapper holding blocks flattened to one text record (capture.mjs:183).
- withTimeout doesn't stop the injected script (export.mjs:85, background.mjs:66).
- Selection scope scans all a[href], misses shadow DOM, no dedupe (capture.mjs:244).
- closest() doesn't cross shadow boundaries (capture.mjs:104).
- Greedy budget skips oversized records (keep, document); counts UTF-16 units.
- retryAt returned but UI ignores it.

## Keep
- Reddit gate: one in-flight request joined by key (background.mjs:51-56), 2 s spacing stamp in storage.local before each fetch, hard cooldown on 429 using Retry-After (seconds or HTTP date, 60 s fallback; format.mjs:22). 2-minute cache surviving worker suspension. Sender/URL validation (:13), tab-changed check (:43). Comment IDs regex-checked, max 100 per morechildren.
- Same-origin fetch in tab (no tokens), payload trimmed in tab (reddit.mjs:137-219), 15 s abort. Iterative ingest; pending/missing/unresolved `more` tracking; `partial` coverage.
- Untrusted-content marking; coverage counters; records whole, never sliced; code whitespace kept; Reddit Markdown raw (raw_json=1).
- Open shadow roots + slot assignment; tables with header/rowspan/colspan/links; list start/reversed/value; blockquote nesting; closed <details> warnings; canvas/iframe "not extracted" notes; URL protocol allow-list; media dedupe; Reddit galleries, captions, video streams with no-audio note; filename sanitising; clipboard fallback.

## v1 data flow
export.mjs init -> capture(fresh). Reddit+auto: message {type:'reddit-request', tabId, postId, sort, children?, fresh?} to worker -> createRedditState -> redditSnapshot. Else executeScript(capturePage,{scope,controls,reddit,postId}). render() -> serialize(snapshot,{maxChars,includeComments,includeMedia}). "More" -> request(children<=100) -> mergeRedditState.
background.mjs handle: validate, cache, gate, executeScript(fetchRedditInPage), 429 -> {ok,json,fetchedAt,cached?}.
reddit.mjs: fetchRedditInPage, createRedditState, mergeRedditState, redditSnapshot, mediaRecords. format.mjs: cleanURL, redditTarget, retryTime, serialize, filename.
