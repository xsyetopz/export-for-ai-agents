# Spec Delta

## ADDED Requirements

### Requirement: PR and discussion dates come from relative-time

The adapter SHALL take a pull request or discussion block's date from its own `relative-time` `datetime`, and
SHALL resolve the pull request body to its `pullrequest-N` id, not the outer `issue-N` wrapper.

#### Scenario: Pull request conversation

- **WHEN** a PR page has a `pullrequest-N` body inside an `issue-N` wrapper, and `issuecomment-N` and
  `pullrequestreview-N` blocks, each with a `relative-time datetime`
- **THEN** each block has its own datetime as its date, and the body id is `pullrequest-N`
