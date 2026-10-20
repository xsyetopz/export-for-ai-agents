# github-adapter Specification

## Purpose

Extracts GitHub issue, pull request and discussion pages into export blocks with correct authors, dates,
ids, titles and state.

## Requirements

### Requirement: Item fields come from the item itself

The adapter SHALL read an item's author, date and body only from elements that belong to that item, not from a
reply nested inside it.

#### Scenario: Parent comment with a nested reply

- **WHEN** a discussion comment contains a reply with a different author and date
- **THEN** the parent block has its own author and date, and the reply block has the reply's

### Requirement: Authors are logins

The adapter SHALL use the login from a profile link when the href is a plain github.com `/login` path, and
SHALL otherwise use the link text.

#### Scenario: React avatar link

- **WHEN** the link text is "skube (skube)" and its href is `/skube`
- **THEN** the author is `skube`

### Requirement: Dates fall back to text

The adapter SHALL use `datetime`, then a matching embedded JSON `createdAt`, then `title`, then text such as
"on Dec 3, 2015" (UTC midnight), and SHALL omit a date that does not parse.

#### Scenario: Server HTML without datetime

- **WHEN** a relative-time element has no attributes, no matching embedded JSON entry, and the text
  "on Dec 3, 2015"
- **THEN** the date is `2015-12-03T00:00:00Z`

#### Scenario: Unparseable text

- **WHEN** the text is "yesterday"
- **THEN** the block has no date

### Requirement: Embedded JSON times match by full id

The adapter SHALL take an item's time from the page's embedded JSON `createdAt` only when the item's full id
matches an entry. It SHALL match by id, never by position. Other timeline events in the JSON SHALL be ignored.

#### Scenario: React issue post

- **WHEN** the post has id `issue-1226848998` and the embedded JSON holds the issue with `databaseId`
  1226848998 and `createdAt` "2026-10-05T09:12:44Z"
- **THEN** the post's date is `2026-10-05T09:12:44Z`

#### Scenario: Comment with a matching id

- **WHEN** the comment has id `issuecomment-5002` and the embedded JSON holds an `IssueComment` with
  `databaseId` 5002 and `createdAt` "2026-10-06T14:21:09Z"
- **THEN** the comment's date is `2026-10-06T14:21:09Z`

#### Scenario: Other timeline event with the same databaseId

- **WHEN** the comment has id `issuecomment-5004`, the embedded JSON holds a `LabeledEvent` with `databaseId`
  5004, and no `IssueComment` with that id
- **THEN** the comment has no embedded date and uses the text fallback

#### Scenario: Comments listed in another order

- **WHEN** the embedded JSON lists comments in a different order than the page
- **THEN** each comment takes the time of its own id

### Requirement: Embedded JSON is read as data

The adapter SHALL parse the embedded JSON as data and SHALL NOT evaluate it. It SHALL skip a script over
1,000,000 characters or one that does not parse, and the capture SHALL still complete.

#### Scenario: Malformed JSON

- **WHEN** the embedded JSON script is not valid JSON
- **THEN** no embedded times are used, dates fall back to `datetime` or text, and the capture completes

#### Scenario: Oversized JSON

- **WHEN** the embedded JSON script is longer than 1,000,000 characters
- **THEN** the script is skipped and dates fall back to `datetime` or text

### Requirement: Ids are full comment ids

The adapter SHALL accept only ids of the form `issuecomment-N`, `discussioncomment-N`, `pullrequestreview-N`,
`pullrequest-N`, `issue-N`, `discussion-N` or `discussion_rN`, found on the item, then an ancestor, then a
descendant.

#### Scenario: Permalink descendants

- **WHEN** an item contains `issuecomment-5-permalink` and sits in `issuecomment-5`
- **THEN** its id is `issuecomment-5`

### Requirement: Titles and states

The adapter SHALL take the title without the issue number and the state from the first matching header,
whether the PR React header, the discussion bucket or the classic header.

#### Scenario: Pull request

- **WHEN** the header has a markdown-title span and a StateLabel "Merged"
- **THEN** the title has no trailing "#number" and the state is "Merged"

### Requirement: Hidden timeline items mark the capture partial

The adapter SHALL mark the capture partial with a warning when a load-more control is present.

#### Scenario: Load-more form

- **WHEN** an `.ajax-pagination-form` is present
- **THEN** coverage `partial` is true and a warning is added
