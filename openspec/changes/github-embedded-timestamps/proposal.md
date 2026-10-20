# Proposal

## Why

On GitHub issue pages the server HTML has no `datetime` on any `relative-time` element. The adapter then rounds
issue and comment dates to midnight UTC. The page's embedded JSON holds exact `createdAt` times for the issue and
for the comments it lists. The timeline is paginated, so not every comment is listed.

## What Changes

- React issue pages: the post and comment dates come from the embedded JSON when the item's full id matches an
  entry. Those dates are exact times.
- Date order becomes `datetime`, embedded JSON, title, text, then omitted. Items missing from the JSON keep the
  text fallback.
- Malformed, oversized or missing embedded JSON is ignored. The capture still succeeds.
- Non-comment timeline events in the JSON (labels, closes, locks) are never used for a comment's date.

Not in scope: pull request and discussion JSON shapes (not checked), network or API calls, and ld+json handling.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `github-adapter`: dates come from embedded JSON before the text fallback, matched by full id. Embedded JSON is
  parsed as data and capped in size.

## Impact

- `src/adapters/github.ts`: builds an id-to-time map from `react-app.embeddedData`; `dateOf` gets the new order.
- `src/adapters/jsonld.ts`: its size caps are the model for the new cap.
- `tests/fixtures/github-issue-react.html` gets an embedded JSON script.
- `tests/thread-adapters.test.ts`: React issue dates change from midnight to exact times.
- No new dependencies. `examples/` is not affected; it is generated from `tests/fixtures/documents.ts`.
