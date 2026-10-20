# Spec Delta

## ADDED Requirements

### Requirement: Dates come from datetime or the title's leading time

The adapter SHALL date a post or comment from `datetime`, else from the ISO time before the first comma of
`title`, and SHALL omit the date when neither parses.

#### Scenario: Comment with a license suffix

- **WHEN** a comment's `title` is "2012-06-27 12:57:01Z, License: CC BY-SA 3.0"
- **THEN** its date is `2012-06-27T12:57:01Z`
