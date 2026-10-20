# body-normalization Specification

## Purpose

Cleans Markdown bodies that adapters take from sites (such as Reddit) so the export is valid, stable Markdown,
without changing code or the meaning of the text.

## Requirements

### Requirement: Escaped backtick runs still open code spans

When a backslash escapes the first backtick of a run of two or more, the normalizer SHALL treat the rest of the
run as a code span opener, as CommonMark does, and SHALL leave text inside that span unchanged.

#### Scenario: Escaped double backtick before a code span

- **WHEN** the body is ``\``<b>` x`` (backslash, two backticks, `<b>`, one backtick)
- **THEN** the output is unchanged, with no `\` added before `<b>`

#### Scenario: Escaped single backtick does not open a span

- **WHEN** the body is ``\`<b>` ``
- **THEN** `<b>` is escaped to `\<b>`, as before

#### Scenario: Escaped run closes at full length

- **WHEN** the body is ``` ``<b>\`` ``` (two backticks, `<b>`, backslash, two backticks)
- **THEN** the output is unchanged, with no `\` added before `<b>`

### Requirement: Only HTML block starts block a hard break

The normalizer SHALL skip the `\` hard break only before a line that starts (after up to three spaces) with a
CommonMark HTML block opener of types 1-6, matched case-insensitively. Any other `<` line, including a lone
complete tag (type 7), SHALL get the hard break, since it continues the paragraph.

#### Scenario: Heart emoticon keeps the hard break

- **WHEN** the body is `a` with two trailing spaces, a newline, then `<3 you`
- **THEN** the output is `a\` then a newline then `<3 you`

#### Scenario: Tag line still blocks the hard break

- **WHEN** the body is `a` with two trailing spaces, a newline, then `<div>`
- **THEN** the output has no `\` after `a`

#### Scenario: Block tag name is case-insensitive

- **WHEN** the body is `a` with two trailing spaces, a newline, then `<DIV>`
- **THEN** the output has no `\` after `a`

#### Scenario: Comment, CDATA and doctype lines block the hard break

- **WHEN** the body is `a` with two trailing spaces, a newline, then `<![CDATA[x]]>` (or `<!DOCTYPE html>`)
- **THEN** the output has no `\` after `a`

#### Scenario: CDATA opener is case-sensitive

- **WHEN** the body is `foo` with two trailing spaces, a newline, then `<![cdata[x]]>`
- **THEN** the output is `foo\`, a newline, then `<![cdata[x]]>`, since only `<![CDATA[` opens an HTML block

#### Scenario: Empty list item keeps the hard break

- **WHEN** the body is `foo` with two trailing spaces, a newline, then `*` (or `+`, `1.`) and trailing spaces
- **THEN** the output is `foo\`, a newline, then the marker alone, since an empty list item cannot interrupt a
  paragraph; a non-empty item such as `*  a` still blocks the break

#### Scenario: Non-block tag text keeps the hard break

- **WHEN** the body is `a` with two trailing spaces, a newline, then `<notatag and text` (or `<b>`)
- **THEN** the output is `a\`, a newline, then the next line with its `<` escaped as `\<`

### Requirement: Code spans may cross lines within a paragraph

The normalizer SHALL find code spans over a whole paragraph (consecutive prose lines), so a span can run across
the line breaks inside it. Text inside a span SHALL be left unchanged. A line that ends inside a span SHALL NOT
get a `\` hard break; its trailing whitespace is still removed.

#### Scenario: Span across a line break

- **WHEN** the body is ``a `<b``, a newline, then ``c>` d``
- **THEN** the output is unchanged

#### Scenario: Tag-like line inside a span

- **WHEN** the body is a backtick, a newline, then ``<a` ``
- **THEN** the output is unchanged, since `<a` does not interrupt a paragraph

#### Scenario: No hard break inside a span

- **WHEN** the body is ``a `x`` with two trailing spaces, a newline, then ``y` z``
- **THEN** the output is ``a `x``, a newline, then ``y` z``, with no `\` added

### Requirement: Paragraphs end at blank lines and block starts

A paragraph SHALL end at a blank line, a line of only `>` quote markers, a code line, or a line that starts a new
block that can interrupt a paragraph in CommonMark (bullet item, ordered item starting at 1, heading, thematic
break, fence, setext underline or HTML block of types 1-6). A `>` line SHALL continue a paragraph only after another
`>` line.

#### Scenario: Ordered item interrupts only from 1

- **WHEN** the body is a backtick, `x`, a newline, then ``1. <b>` ``
- **THEN** the `<` is escaped, since `1.` starts a new paragraph; with `2.` or `01)` the output is unchanged

#### Scenario: HTML block start ends a paragraph

- **WHEN** the body is a backtick, `x`, a newline, then ``<DIV>` ``
- **THEN** the `<` is escaped, since `<DIV>` starts an HTML block; with `<![CDATA[` or `<!DOCTYPE` in place of
  `<DIV>` the output is unchanged

#### Scenario: Span stops at a blank line

- **WHEN** the body is ``a `x``, a blank line, then ``<b>` y``
- **THEN** the second paragraph becomes ``\<b>` y``, so its `<` is escaped

### Requirement: Link destinations in angle brackets stay unescaped

The normalizer SHALL NOT escape a `<` that opens a link or image destination, including when spaces, tabs or one
line break sit between `](` and `<`.

#### Scenario: Spaces before an angle-bracket destination

- **WHEN** the body is `[a](  <b c>)`
- **THEN** the output is unchanged

#### Scenario: Line break before an angle-bracket destination

- **WHEN** the body is ``[a](``, a newline, then ``<b c>)``
- **THEN** the output is unchanged

#### Scenario: Bare tag-like text is still escaped

- **WHEN** the body is `use <name> here`
- **THEN** the output is `use \<name> here`

### Requirement: Reference definition destinations stay unescaped

The normalizer SHALL NOT escape a `<` that opens the destination of a link reference definition (`[label]: <dest>`),
even when the destination starts on the next line. A definition line counts only at the start of a paragraph or
right after another definition line, since a definition cannot interrupt a paragraph. A definition line may have up
to three spaces of indent and `>` quote markers; its label is 1 to 999 characters with no unescaped brackets.

#### Scenario: Angle-bracket definition

- **WHEN** the body is `[x]: <y>`
- **THEN** the output is unchanged

#### Scenario: Destination on the next line

- **WHEN** the body is ``[x]:``, a newline, then ``<y>``
- **THEN** the output is unchanged

#### Scenario: Quoted definition

- **WHEN** the body is `> [x]: <y>`
- **THEN** the output is unchanged

#### Scenario: Definition after a paragraph line

- **WHEN** the body is `foo`, a newline, then `[x]: <y>`
- **THEN** the second line becomes `[x]: \<y>`, since it is not a definition here

#### Scenario: Bare label line that is not a definition keeps its hard break

- **WHEN** the body is `foo`, a newline, `[x]:` with two trailing spaces, a newline, then `bar`
- **THEN** the second line becomes `[x]:\`, since it is not a definition here
