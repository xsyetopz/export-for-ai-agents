import { expect, test } from "bun:test";
import { adapters, selectAdapter } from "../src/adapters/index.ts";
import {
  type Adapter,
  AdapterError,
  isNotThisLayout,
  NotThisLayoutError,
} from "../src/adapters/types.ts";

const fake = (id: string, host: string): Adapter => ({
  id,
  matches: (url) => new URL(url).hostname === host,
  capture: async () => {
    throw new Error("unused");
  },
});

test("generic is last and matches everything", () => {
  expect(adapters.at(-1)?.id).toBe("generic");
  expect(selectAdapter("https://anything.example/x").id).toBe("generic");
});

test("first match wins; generic last", () => {
  const list: Adapter[] = [
    fake("a", "a.example"),
    fake("a2", "a.example"),
    fake("b", "b.example"),
    ...adapters,
  ];
  expect(selectAdapter("https://a.example/", list).id).toBe("a");
  expect(selectAdapter("https://b.example/", list).id).toBe("b");
  expect(selectAdapter("https://c.example/", list).id).toBe("generic");
});

test("a throwing matcher is skipped; invalid urls fall to generic", () => {
  const list: Adapter[] = [fake("a", "a.example"), ...adapters];
  expect(selectAdapter("not a url", list).id).toBe("generic");
});

test("only the structural error allows generic fallback", () => {
  expect(isNotThisLayout(new NotThisLayoutError())).toBe(true);
  expect(isNotThisLayout(new AdapterError("rate_limited", "x"))).toBe(false);
  expect(isNotThisLayout(new Error("not_this_layout"))).toBe(false);
  expect(new NotThisLayoutError().code).toBe("not_this_layout");
});
