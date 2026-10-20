# date-parsing Specification

## Purpose
TBD - created by archiving change date-parsing-followups. Update Purpose after archive.

## Requirements

### Requirement: Only unambiguous dates are accepted

`isoDate` SHALL accept only epoch seconds (9 to 11 digits), ISO dates or date-times (zone-less is UTC, date-only
is UTC midnight), and RFC 1123/2822 dates with an explicit zone. It SHALL reject out-of-range components without
rolling them over, and SHALL return undefined for any other text.

#### Scenario: RFC date with a zone

- **WHEN** the text is "3 Dec 2015 12:00 +0200"
- **THEN** the date is `2015-12-03T10:00:00Z`

#### Scenario: Impossible RFC date

- **WHEN** the text is "31 Feb 2015 10:00:00 GMT"
- **THEN** there is no date

#### Scenario: Text with a T

- **WHEN** the text is "Tue, 03 Dec 2015 10:00:00" (no zone) or "Test 2026-10-05"
- **THEN** there is no date

#### Scenario: Free-form text

- **WHEN** the text is "Dec 3, 2015"
- **THEN** there is no date

#### Scenario: Out-of-range offset or year

- **WHEN** the text is "2026-10-19T10:00:00+24:00", "0099-01-01", or "9999-12-31T23:59:59-14:00"
- **THEN** there is no date, because offsets past 23:59 and any written or UTC year outside 1000..9999 are rejected
