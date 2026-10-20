# Tasks

## 1. isoDate

- [x] 1.1 Reject out-of-range literal date and time components in `isoDate` (`src/adapters/thread-dom.ts`). Verify: `bun test tests/iso-date.test.ts`.
- [x] 1.2 Drop the rollover probe in `dateOf` (`src/adapters/github.ts`). Verify: `bun test tests/thread-adapters.test.ts`.

## 2. Embedded JSON

- [x] 2.1 Read all embedded-data scripts in `embeddedTimes` with a script cap and shared node budget. Verify: `bun test tests/thread-adapters.test.ts`.

## 3. Gate

- [x] 3.1 `bun run verify` exits 0 and `git status` shows no changes under `examples/`.
