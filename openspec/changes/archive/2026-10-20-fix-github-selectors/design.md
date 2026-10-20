# Design

## Context

Checked against saved logged-out server HTML of an issue (React layout), a PR (classic timeline, React
header) and a discussion (classic). Hydration was not checked.

## Decisions

- **Own-element lookups.** `ownMatch` returns the first match whose `closest(layout.items)` is the item, so a
  discussion parent never takes a nested reply's author or date. Used for author, date and body.
- **Author.** Login from the link's href when it is a plain `/login` path on github.com, else the text. The React
  avatar link text is "login (display name)".
- **Date.** `datetime`, then `title`, then the text with a leading "on " stripped. Only "Mon D, YYYY" text is
  accepted and becomes UTC midnight via a date-only ISO string (no timezone dependence); relative text such as
  "yesterday" is dropped. Server `relative-time` has no `datetime`; hydration may add it (unverified).
- **PR review date.** The review item has no time element; its timestamp sits in the wrapper
  `#pullrequestreview-N`, so that is the fallback for items without a date.
- **Ids.** `commentId` accepts only `issuecomment|discussioncomment|pullrequestreview|pullrequest|issue|discussion-N`
  and `discussion_rN`. Order: the item, ancestors (nearest first, so a reply finds its own wrapper), descendants.
  The React issue body id comes from its header link fragment.
- **Title and state** are selector lists tried in order, with `h1` as the last title fallback.
- **Progressive loader rejected.** `#js-timeline-progressive-loader` loads a `#hash`-focused item, not hidden
  items, so it is not a partial signal (it is present on fully captured PRs). `.ajax-pagination-form` stays.

## Risks

GitHub markup changes without notice. Misses degrade to missing fields or the generic adapter.
