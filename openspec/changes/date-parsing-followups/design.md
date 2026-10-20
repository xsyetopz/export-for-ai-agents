# Design

## Decisions

### Anchored ISO shape, hand-built RFC parsing

`isoDate` matches the whole string against an anchored ISO shape, validates the written month, day (leap
years), hour, minute and second, and appends "Z" only to a date-time that has no zone. Date-only input is UTC
midnight. RFC 1123/2822 input (`[Ddd, ]D[D] Mon YYYY hh:mm[:ss] zone`, zone GMT, UTC, UT, Z or `+-hhmm`) is
validated and converted with `Date.UTC` minus the offset, never `Date.parse`. A weekday name is not checked.
Offsets must be at most 23:59, and the written and resulting UTC year must be 1000..9999 (this avoids `Date.UTC`'s 0-99 year mapping and extended `+010000` years). Zone-less RFC text and everything else (including "Dec 3, 2015") returns undefined, so results never depend on
the local time zone. Reddit's own epoch-only `isoDate` is unaffected; callers in GitHub, Hacker News and
Stack Exchange already pass ISO or epoch text.

### Stack Exchange title

A `title` may be `"<ISO time>, License: ..."`. A helper takes `datetime` when it parses, else the text before
the first comma of `title`, for both post signatures and comments. `isoDate` is not loosened.

### GitHub PR and discussions

These are classic server HTML. PR embedded data has no `createdAt`; discussions have none. Dates come from each
block's `relative-time datetime`. The PR body resolves to `pullrequest-N`, not the outer `issue-N` wrapper
(the fixture already has that wrapper).
