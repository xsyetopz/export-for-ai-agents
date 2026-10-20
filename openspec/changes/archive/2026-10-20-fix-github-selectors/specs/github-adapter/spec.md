## ADDED Requirements

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

The adapter SHALL use `datetime`, then `title`, then text such as "on Dec 3, 2015" (UTC midnight), and SHALL
omit a date that does not parse.

#### Scenario: Server HTML without datetime

- **WHEN** a relative-time element has no attributes and the text "on Dec 3, 2015"
- **THEN** the date is `2015-12-03T00:00:00Z`

#### Scenario: Unparseable text

- **WHEN** the text is "yesterday"
- **THEN** the block has no date

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
