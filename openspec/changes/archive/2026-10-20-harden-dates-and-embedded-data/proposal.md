# Proposal

## Why

Two leftovers from review. GitHub pages can carry several `react-app.embeddedData` scripts, but only the first is
read. And `isoDate` hands strings to `Date.parse`, which rolls impossible dates over ("2026-02-30" becomes
March 2), so bad dates are exported as real ones.

## What Changes

- `isoDate` rejects ISO-shaped input whose written date or time is out of range, checked before zone conversion.
- GitHub embedded times are read from every embedded-data script (capped in count); bad scripts are skipped.
- `dateOf` drops its own "Feb 31" probe and relies on `isoDate`.

## Capabilities

### Modified Capabilities

- `github-adapter`: embedded JSON is read from all embedded-data scripts; impossible dates are omitted.

## Impact

- `src/adapters/thread-dom.ts` (`isoDate`, shared by GitHub, Stack Exchange and Hacker News), `src/adapters/github.ts`.
- `tests/iso-date.test.ts`, `tests/thread-adapters.test.ts`. No new dependencies; `examples/` unaffected.
