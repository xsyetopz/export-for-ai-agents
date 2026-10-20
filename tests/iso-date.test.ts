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

test("isoDate still parses non-ISO strings through Date.parse", () => {
  // Non-ISO text is read in local time, so only the day is asserted.
  expect(isoDate("Dec 3, 2015")).toMatch(/^2015-12-0[23]T/);
});
