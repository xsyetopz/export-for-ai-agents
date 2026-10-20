# Spec Delta

## ADDED Requirements

### Requirement: Block-marker lines take no hard break

The normalizer SHALL NOT add a `\` hard break to a line that is itself a block marker at the start of a
paragraph: an empty list item (a bullet or ordered marker with nothing after it), an ATX heading, a thematic
break, a setext underline, or a line of only `>` quote markers. A `\` there would become literal text in the
list item, heading or underline.

#### Scenario: Empty bullet at paragraph start

- **WHEN** the body is `*` with two trailing spaces, a newline, then `bar`
- **THEN** the output is `*`, a newline, then `bar`, with no `\`

#### Scenario: Empty ordered item at paragraph start

- **WHEN** the body is `1.` with two trailing spaces, a newline, then `bar`
- **THEN** the output is `1.`, a newline, then `bar`

#### Scenario: Heading, thematic break and setext underline

- **WHEN** the body is `# h` (or `---`, or `a`, a newline, `===`) with two trailing spaces on the last marker
  line, a newline, then `bar`
- **THEN** the marker line has no `\` added

#### Scenario: Marker mid-paragraph is plain text

- **WHEN** the body is `a`, a newline, `*` with two trailing spaces, a newline, then `bar`
- **THEN** the output is `a`, a newline, `*\`, a newline, then `bar`, since an empty item cannot interrupt a
  paragraph

### Requirement: Closing HTML tags are escaped like opening tags

The normalizer SHALL escape a `<` that is followed by `/` and an ASCII letter (`</div>`) outside code spans and
code blocks, as it does for `<` followed by a letter, unless the `<` opens a link or reference destination or an
autolink. A `<` followed by `/` and anything else, and the comment, processing instruction, declaration and CDATA
openers (`<!`, `<?`), SHALL stay unchanged.

#### Scenario: Closing block tag on its own line

- **WHEN** the body is `</div>`
- **THEN** the output is `\</div>`

#### Scenario: Closing tag in prose

- **WHEN** the body is `a </b> c`
- **THEN** the output is `a \</b> c`

#### Scenario: Closing tag inside a code span

- **WHEN** the body is ``use `</div>` here``
- **THEN** the output is unchanged

#### Scenario: Not a tag

- **WHEN** the body is `1 </ 2` or `a </3`
- **THEN** the output is unchanged

#### Scenario: Comment opener stays unchanged

- **WHEN** the body is `a <!-- c -->`
- **THEN** the output is unchanged

### Requirement: Indented code inside block quotes is left untouched

The normalizer SHALL treat a line as indented code when, after its `>` quote markers (each followed by one
optional space), it has four or more columns of indent, and SHALL leave that line unchanged, trailing whitespace
and `<` included. This holds for quotes nested in quotes and for lists inside quotes. A line indented four or more
columns inside a list item SHALL keep being treated as code.

#### Scenario: Quoted indented code

- **WHEN** the body is `> a`, a newline, `>`, a newline, then `>` followed by five spaces and `<b>` with trailing
  spaces
- **THEN** the last line is unchanged, with no `\` before `<b>` and its trailing spaces kept

#### Scenario: Quoted text indented less than four columns

- **WHEN** the body is `>` followed by four spaces and `<b>`
- **THEN** the output is `>` followed by four spaces and `\<b>`

#### Scenario: Indented code inside a list item

- **WHEN** the body is `- a`, a blank line, then six spaces and `<b>`
- **THEN** the output is unchanged

## MODIFIED Requirements

### Requirement: Only HTML block starts block a hard break

The normalizer SHALL skip the `\` hard break only before a line that can interrupt a paragraph: a line that
starts (after up to three spaces) with a CommonMark HTML block opener of types 1-6 (matched case-insensitively),
a non-empty bullet item, an ordered item that starts at 1, a heading, a thematic break, a fence, a quote or a
setext underline. Any other line, including a lone complete tag (type 7) and an ordered item that starts at a
number other than 1, SHALL get the hard break, since it continues the paragraph. The exception is a paragraph
inside a list item: there, an ordered item before the next line is a sibling item, so the break is skipped
before any ordered item.

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

#### Scenario: Ordered item not starting at 1 keeps the hard break

- **WHEN** the body is `a` with two trailing spaces, a newline, then `2. b` (or `01) b`)
- **THEN** the output is `a\`, a newline, then the item line unchanged

#### Scenario: Ordered item starting at 1 blocks the hard break

- **WHEN** the body is `a` with two trailing spaces, a newline, then `1. b`
- **THEN** the output has no `\` after `a`

#### Scenario: Next list item inside a list takes no hard break

- **WHEN** the body is `1. a` with two trailing spaces, a newline, then `2. b`
- **THEN** the output has no `\` after `a`
