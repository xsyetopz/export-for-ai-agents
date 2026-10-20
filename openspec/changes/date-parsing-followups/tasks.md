# Tasks

## 1. isoDate

- [x] 1.1 Restrict `isoDate` to epoch, ISO and zoned RFC 1123/2822 (`src/adapters/thread-dom.ts`) and extend `tests/iso-date.test.ts`. Verify: `bun test tests/iso-date.test.ts`.

## 2. Stack Exchange

- [x] 2.1 Read the leading ISO time of `title` for posts and comments (`src/adapters/stackexchange.ts`); give the fixture a license-suffixed comment title. Verify: `bun test tests/thread-adapters.test.ts`.

## 3. GitHub

- [x] 3.1 Confirm PR and discussion fixtures give classic layout, per-block `datetime` dates and `pullrequest-N` ids; update the `embeddedTimes` comment. Verify: `bun test tests/thread-adapters.test.ts`.

## 4. Gate

- [x] 4.1 `bun run verify` exits 0.
