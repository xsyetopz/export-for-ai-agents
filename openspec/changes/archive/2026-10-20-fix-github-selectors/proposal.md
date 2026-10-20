# Proposal

## Why

A check of `src/adapters/github.ts` against live GitHub server HTML (logged out, not hydrated) showed the
selectors had drifted. React issue comments had no author or date, PR and discussion titles carried a trailing
`#number`, discussion authors and dates were empty, and ids picked descendants such as `issuecomment-1-permalink`.

## What Changes

- React issue view: author from the avatar link (login from its href), dates from the header links, with a
  text fallback ("on Dec 3, 2015"), and the issue body id from its header link.
- Classic layout: titles from `h1 .markdown-title` and `h1 .js-issue-title`; state tried in order (PR React
  header, discussion bucket, old header); discussion author and date from `.timeline-comment-header-text`.
- Author, date and body are taken from the item itself, never from a nested reply.
- Ids must look like a full comment id and are looked up on the item, then its ancestors, then descendants;
  `pullrequest-` is a known prefix. A PR review takes its date from its wrapper.

## Capabilities

### New Capabilities

- `github-adapter`: how the GitHub adapter reads issue, pull request and discussion pages.

### Modified Capabilities

None.

## Impact

`src/adapters/github.ts`, fixtures and tests under `tests/`.
