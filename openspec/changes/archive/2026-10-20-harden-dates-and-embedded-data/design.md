# Design

## Decisions

### Validate the literal, not the parsed value

`isoDate` matches `YYYY-MM-DD` with an optional `T`/space `HH:MM[:SS]` at the start and checks month 1-12, day
against the month length (leap years by the Gregorian rule), hour 0-23, minute 0-59, second 0-59. This runs on the
written text before `Date.parse`, so a valid local date that crosses midnight in UTC ("2026-10-31T23:30:00-02:00")
still works. Hour 24 and second 60 are rejected. Input that is not ISO-shaped goes to `Date.parse` as before; epoch
seconds skip the check. Reddit has its own epoch-only `isoDate`, unaffected.

### Embedded scripts

`embeddedTimes` walks up to 8 scripts, each with the existing size cap and try/catch. The first value per key wins
across scripts. The `MAX_EMBEDDED_NODES` budget (100,000) is shared across all scripts, so many scripts cannot
multiply the work. Once it is spent, the remaining scripts are not parsed.

### dateOf

The text path still builds `YYYY-MM-DD` from "Feb 31, 2026" and now relies on `isoDate` to reject it.
