# Tasks

## 1. Fixture

- [x] 1.1 Add a `react-app.embeddedData` script to `tests/fixtures/github-issue-react.html`: issue 5001 with `createdAt` "2026-10-05T09:12:44Z", `IssueComment` 5002 with "2026-10-06T14:21:09Z", `IssueComment` 5003 with "2026-10-07T03:15:00Z", a `LabeledEvent` with `databaseId` 5004, and no `IssueComment` 5004. Verify: `bun test tests/thread-adapters.test.ts` still passes unchanged, because no code reads the script yet.

## 2. Embedded JSON dates

- [x] 2.1 Build the id-to-`createdAt` map in `src/adapters/github.ts` from the parsed `react-app.embeddedData` script. Walk it with bounded depth, key only the issue and `IssueComment` nodes, and reuse the `jsonld.ts` size cap. Verify: `bun run typecheck` and `bun run lint:code` pass; behaviour is covered by 2.4.
- [x] 2.2 Change `dateOf` to the order `datetime`, embedded JSON, zoned `title`, text, then omitted, matching by the item's own full id. Verify: `bun run typecheck` passes, and 2.3 and 2.4 pass.
- [x] 2.3 Update expectations in `tests/thread-adapters.test.ts` for the React issue fixture: `published` and issue 5001 are "2026-10-05T09:12:44Z"; 5002 is "2026-10-06T14:21:09Z"; 5003 stays "2026-10-07T08:00:00Z" (`datetime` beats JSON); 5004 has no date. Verify: `bun test tests/thread-adapters.test.ts` passes.
- [x] 2.4 Add tests in `tests/thread-adapters.test.ts` for the variants, built by editing the fixture string: no script, or 5002 removed from the JSON (5002 falls back to "2026-10-06T00:00:00Z"); malformed JSON (no error, same fallback); a script over 1,000,000 characters (skipped); comments reordered in the JSON (each still maps by id). Verify: `bun test tests/thread-adapters.test.ts` passes.

## 3. Gate

- [x] 3.1 Run `bun run verify` and confirm it exits 0. Confirm `git status` shows no changes under `examples/`, which this change does not touch.

## Workflow follow-up

- Archive the change once `bun run verify` passes.
