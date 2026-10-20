import { expect, test } from "bun:test";
import {
  exportFilename,
  MIME_JSONL,
  MIME_MARKDOWN,
  mimeFor,
  slugify,
} from "../src/naming.ts";

const at = "2026-09-23T01:02:03.456Z";

test("basic filename", () => {
  expect(
    exportFilename("https://www.Example.com/Foo/Bar_Baz?x=1#h", at, "md"),
  ).toBe("example.com-foo-bar-baz-20260923T010203Z.md");
});

test("root path and missing slug", () => {
  expect(exportFilename("https://example.com/", at, "jsonl")).toBe(
    "example.com-20260923T010203Z.jsonl",
  );
});

test("unicode host becomes punycode, unicode path is transliterated or dropped", () => {
  expect(exportFilename("https://münchen.de/", at, "md")).toBe(
    "xn--mnchen-3ya.de-20260923T010203Z.md",
  );
  expect(exportFilename("https://example.com/caf%C3%A9/日本語", at, "md")).toBe(
    "example.com-cafe-20260923T010203Z.md",
  );
});

test("long paths are capped at 60 chars without trailing dash", () => {
  const slug = slugify(`/${"abcd-".repeat(30)}`);
  expect(slug.length).toBeLessThanOrEqual(60);
  expect(slug.endsWith("-")).toBe(false);
});

test("malformed escapes and invalid urls do not throw", () => {
  expect(slugify("/%E0%A4%A")).toBe("e0-a4-a");
  expect(exportFilename("not a url", at, "md")).toBe(
    "page-20260923T010203Z.md",
  );
});

test("mime types", () => {
  expect(mimeFor("md")).toBe(MIME_MARKDOWN);
  expect(mimeFor("jsonl")).toBe(MIME_JSONL);
  expect(MIME_MARKDOWN).toBe("text/markdown;charset=utf-8");
});

test("invalid date falls back instead of throwing", () => {
  expect(exportFilename("https://example.com/", "garbage", "md")).toMatch(
    /^example\.com-\d{8}T\d{6}Z\.md$/,
  );
});
