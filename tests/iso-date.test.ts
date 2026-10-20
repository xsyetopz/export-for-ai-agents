import { expect, test } from "bun:test";
import { isoDate } from "../src/adapters/thread-dom.ts";

test("isoDate rejects impossible calendar components", () => {
  for (const bad of [
    "2026-02-30",
    "2026-02-29",
    "2026-04-31T00:00:00+02:00",
    "2026-13-01",
    "2026-00-10",
    "2026-10-00",
    "2026-10-05T25:00:00Z",
    "2026-10-05T24:00:00Z",
    "2026-10-05T10:60:00Z",
    "2026-10-05 10:00:60",
  ])
    expect(isoDate(bad), bad).toBeUndefined();
});

test("isoDate accepts real dates, leap days, offsets and epoch seconds", () => {
  expect(isoDate("2028-02-29")).toBe("2028-02-29T00:00:00Z");
  expect(isoDate("2000-02-29T12:00:00Z")).toBe("2000-02-29T12:00:00Z");
  expect(isoDate("2026-10-19 10:00:00")).toBe("2026-10-19T10:00:00Z");
  // The offset carries the instant into the next UTC day; the written date is still valid.
  expect(isoDate("2026-10-31T23:30:00-02:00")).toBe("2026-11-01T01:30:00Z");
  expect(isoDate("2026-04-30T01:00:00+02:00")).toBe("2026-04-29T23:00:00Z");
  expect(isoDate("1760000000")).toBe("2025-10-09T08:53:20Z");
});

test("isoDate accepts RFC 1123/2822 dates with an explicit zone", () => {
  expect(isoDate("Tue, 03 Dec 2015 10:00:00 GMT")).toBe("2015-12-03T10:00:00Z");
  expect(isoDate("3 Dec 2015 12:00 +0200")).toBe("2015-12-03T10:00:00Z");
  expect(isoDate("Thu, 01 Jan 2026 00:30:00 +0100")).toBe(
    "2025-12-31T23:30:00Z",
  );
  expect(isoDate("29 Feb 2028 23:59:59 -0500")).toBe("2028-03-01T04:59:59Z");
  expect(isoDate("03 dec 2015 10:00:00 UT")).toBe("2015-12-03T10:00:00Z");
});

test("isoDate rejects invalid or zone-less RFC dates and free text", () => {
  for (const bad of [
    "31 Feb 2015 10:00:00 GMT",
    "29 Feb 2027 10:00:00 GMT",
    "3 Dec 2015 24:00:00 GMT",
    "3 Dec 2015 10:61:00 GMT",
    "3 Dec 2015 10:00:00 +2500",
    "3 Foo 2015 10:00:00 GMT",
    "Tue, 03 Dec 2015 10:00:00",
    "Dec 3, 2015",
    "Tuesday at 10",
    "Test 2026-10-05",
    "2026-10-05T10:00:00 later",
  ])
    expect(isoDate(bad), bad).toBeUndefined();
});

test("isoDate checks offsets and year bounds", () => {
  expect(isoDate("2026-10-19T10:00:00+0200")).toBe("2026-10-19T08:00:00Z");
  for (const bad of [
    "2026-10-19T10:00:00+24:00",
    "2026-10-19T10:00:00+0260",
    "9999-12-31T23:59:59-14:00",
    "0999-12-31T00:00:00Z",
    "0099-01-01",
    "1000-01-01T00:00:00+01:00",
    "1 Jan 0099 10:00:00 GMT",
  ])
    expect(isoDate(bad), bad).toBeUndefined();
  expect(isoDate("1000-01-01T00:00:00Z")).toBe("1000-01-01T00:00:00Z");
  expect(isoDate("9999-12-31T23:59:59Z")).toBe("9999-12-31T23:59:59Z");
});
