# Spec Delta

## MODIFIED Requirements

### Requirement: Embedded JSON is read as data

The adapter SHALL parse the embedded JSON as data and SHALL NOT evaluate it. It SHALL read every
`react-app.embeddedData` script, up to 8, skipping any over 1,000,000 characters or that does not parse, and SHALL
keep the first time found for each id. The capture SHALL still complete.

#### Scenario: Malformed JSON

- **WHEN** the embedded JSON script is not valid JSON
- **THEN** no embedded times are used, dates fall back to `datetime` or text, and the capture completes

#### Scenario: Oversized JSON

- **WHEN** the embedded JSON script is longer than 1,000,000 characters
- **THEN** the script is skipped and dates fall back to `datetime` or text

#### Scenario: Time only in a later script

- **WHEN** the first embedded-data script is malformed and the second holds the comment's `createdAt`
- **THEN** the comment takes the time from the second script

## ADDED Requirements

### Requirement: Impossible dates are omitted

The adapter SHALL omit a date whose written month, day, hour, minute or second is out of range, and SHALL NOT
roll it over to another day.

#### Scenario: Day out of range

- **WHEN** a `datetime` is "2026-02-30" or the text is "Feb 31, 2026"
- **THEN** the block has no date from that source

#### Scenario: Offset crossing midnight

- **WHEN** a `datetime` is "2026-10-31T23:30:00-02:00"
- **THEN** the date is `2026-11-01T01:30:00Z`
