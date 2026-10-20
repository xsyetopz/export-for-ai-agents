# Design

## Context

`dateOf` in `src/adapters/github.ts` reads `datetime`, then the zoned `title`, then text. See proposal.md - Why.

On React issue pages the server HTML has no `datetime`. The `react-app.embeddedData` script holds the issue at
`payload.issueViewerRoute.data.repository.issue`, with `createdAt` and `databaseId`. Its comments sit under
`timelineItems` and `backTimelineItems` as `IssueComment` nodes. The issue object has no `__typename`. The DOM ids
`issue-N` and `issuecomment-N` equal the JSON `databaseId` values. Timeline events such as `LabeledEvent` also carry
`createdAt` and `databaseId`. `src/adapters/jsonld.ts` already parses embedded JSON with size caps.

## Goals / Non-Goals

**Goals:**

- Exact post and comment times on React issue pages when the JSON lists them.
- No change on pages without the JSON, and no new failure modes.

**Non-Goals:**

- Pull request and discussion JSON shapes. They are not verified. The mapping is written to be generic, but only the
  issue page is tested.
- GitHub API calls.
- Changes to ld+json handling.

## Decisions

### One id-to-time map per capture

Walk the parsed `react-app.embeddedData` once, with bounded depth and entry count. Key the issue as `issue-N` and
each `IssueComment` as `issuecomment-N`. `dateOf` looks up the item's own full id.

The issue is recognised by its parent key (`issue`, under `repository`), since it has no `__typename`. Comments are
recognised by `__typename: "IssueComment"`. Other events are never keyed as comments.

- Alternative: match the nth comment element to the nth JSON node. Rejected. The timeline is paginated, so positions
  drift.
- Alternative: accept any object with `createdAt` and `databaseId`. Rejected. Timeline events have the same fields.
- Alternative: take the post time from ld+json `datePublished`. It is exact, but it covers only the post. Not used.
- Alternative: call the GitHub API. Rejected. It needs network access, has rate limits and may need auth.

### Source order

`datetime` stays first. It is exact when present, for example on pages where the DOM already has it. Then the
embedded JSON, then the zoned `title`, then text.

### Matching is by full id

An item matches only on its own full id. The id rule is the one in the "Ids are full comment ids" requirement. A
stale or partial script can only match items it describes.

### Parsed as data, with caps

Use the caps from `src/adapters/jsonld.ts`: a script over 1,000,000 characters is skipped. A script that does not
parse is skipped without an error. The script is parsed, never evaluated.

## Risks / Trade-offs

- [GitHub changes the JSON shape] → The map is empty and dates fall back to text, as today. The fixture shows the
  expected shape. A check against a live page is manual.
- [The JSON is partial, because the timeline is paginated] → Items without an entry keep the text fallback. Their
  dates stay at midnight UTC.
- [Client-side navigation leaves an old script in the DOM] → Matching is by full id, so entries only match the items
  they describe.
- [The hydrated DOM may already carry `datetime`] → `datetime` stays first, so nothing changes. Not verified.
- [Extra work per capture] → One parse of at most 1,000,000 characters and a bounded walk.

## Migration Plan

No data migration. Ships with the next build. Rollback is a revert: dates on React issue pages go back to midnight UTC.

## Open Questions

- Do pull request and discussion pages embed the same JSON shape? Not checked. Until checked, those pages keep the
  `datetime` and text fallback. The issue spec and tasks do not depend on the answer.
