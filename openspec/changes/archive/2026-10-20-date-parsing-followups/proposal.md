# Proposal

## Why

Review of the date work found three gaps. `isoDate` appends "Z" to any text containing a "T" (so "Tue, 03 Dec
2015 10:00:00 GMT" fails) and sends non-ISO text to `Date.parse` unchecked (local time, "Feb 31" rolls over).
Stack Exchange comment dates sit in `title="2012-06-27 12:57:01Z, License: CC BY-SA 3.0"`, which `isoDate`
cannot read. GitHub pull request and discussion dates need confirming against the live markup.

## What Changes

- `isoDate` accepts only epoch seconds, ISO dates, and RFC 1123/2822 dates with an explicit zone.
- The Stack Exchange adapter reads the ISO time before the first comma of `title`.
- GitHub PR and discussion dates are covered by tests; the `embeddedTimes` comment says only issues use embedded data.

## Capabilities

### New Capabilities

- `date-parsing`: which date strings `isoDate` accepts and how.
- `stackexchange-adapter`: date reading for posts and comments.

### Modified Capabilities

- `github-adapter`: PR and discussion dates come from each block's own `relative-time datetime`.

## Impact

- `src/adapters/thread-dom.ts`, `src/adapters/stackexchange.ts`, `src/adapters/github.ts` (comment only).
- `tests/iso-date.test.ts`, `tests/thread-adapters.test.ts`, `tests/fixtures/stackexchange-question.html`.
