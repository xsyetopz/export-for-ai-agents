# Spec Delta

## MODIFIED Requirements

### Requirement: Dates fall back to text

The adapter SHALL use `datetime`, then a matching embedded JSON `createdAt`, then `title`, then text such as "on Dec 3, 2015" (UTC midnight), and SHALL omit a date that does not parse.

#### Scenario: Server HTML without datetime

- **WHEN** a relative-time element has no attributes, no matching embedded JSON entry, and the text "on Dec 3, 2015"
- **THEN** the date is `2015-12-03T00:00:00Z`

#### Scenario: Unparseable text

- **WHEN** the text is "yesterday"
- **THEN** the block has no date

## ADDED Requirements

### Requirement: Embedded JSON times match by full id

The adapter SHALL take an item's time from the page's embedded JSON `createdAt` only when the item's full id matches an entry. It SHALL match by id, never by position. Other timeline events in the JSON SHALL be ignored.

#### Scenario: React issue post

- **WHEN** the post has id `issue-1226848998` and the embedded JSON holds the issue with `databaseId` 1226848998 and `createdAt` "2026-10-05T09:12:44Z"
- **THEN** the post's date is `2026-10-05T09:12:44Z`

#### Scenario: Comment with a matching id

- **WHEN** the comment has id `issuecomment-5002` and the embedded JSON holds an `IssueComment` with `databaseId` 5002 and `createdAt` "2026-10-06T14:21:09Z"
- **THEN** the comment's date is `2026-10-06T14:21:09Z`

#### Scenario: Other timeline event with the same databaseId

- **WHEN** the comment has id `issuecomment-5004`, the embedded JSON holds a `LabeledEvent` with `databaseId` 5004, and no `IssueComment` with that id
- **THEN** the comment has no embedded date and uses the text fallback

#### Scenario: Comments listed in another order

- **WHEN** the embedded JSON lists comments in a different order than the page
- **THEN** each comment takes the time of its own id

### Requirement: Embedded JSON is read as data

The adapter SHALL parse the embedded JSON as data and SHALL NOT evaluate it. It SHALL skip a script over 1,000,000 characters or one that does not parse, and the capture SHALL still complete.

#### Scenario: Malformed JSON

- **WHEN** the embedded JSON script is not valid JSON
- **THEN** no embedded times are used, dates fall back to `datetime` or text, and the capture completes

#### Scenario: Oversized JSON

- **WHEN** the embedded JSON script is longer than 1,000,000 characters
- **THEN** the script is skipped and dates fall back to `datetime` or text
