import { vi, describe, it, expect } from "vitest";

vi.hoisted(() => {
  process.env.SQLITE_DB_PATH = ":memory:";
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

vi.mock("../src/modules/bot-events/bot-event-log.js", () => ({
  botEventLog: { record: vi.fn() },
}));

import {
  matchesTrigger,
  matchTrigger,
  __regexCacheSizeForTests,
} from "../src/modules/behavior/behavior-trigger.js";
import { botEventLog } from "../src/modules/bot-events/bot-event-log.js";
import { compileTriggerRegex } from "../src/utils/linear-regex.js";

describe("behavior-trigger.matchesTrigger", () => {
  describe("patternKind=startswith", () => {
    it("matches when content begins with the pattern", () => {
      expect(matchesTrigger("startswith", "!ping", "!ping hello world")).toBe(true);
    });
    it("rejects when the pattern is elsewhere in the content", () => {
      expect(matchesTrigger("startswith", "!ping", "hello !ping")).toBe(false);
    });
    it("is case-sensitive (caller must lower-case if it wants otherwise)", () => {
      expect(matchesTrigger("startswith", "Hi", "hi there")).toBe(false);
    });
    it("matches empty pattern against any content", () => {
      expect(matchesTrigger("startswith", "", "anything")).toBe(true);
    });
  });

  describe("patternKind=endswith", () => {
    it("matches when content ends with the pattern", () => {
      expect(matchesTrigger("endswith", "bye!", "goodbye!")).toBe(true);
      expect(matchesTrigger("endswith", "bye", "goodbye!")).toBe(false);
    });
    it("rejects when content is shorter than the pattern", () => {
      expect(matchesTrigger("endswith", "longer-than-content", "x")).toBe(false);
    });
  });

  describe("patternKind=regex", () => {
    it("matches when the regex tests true against content", () => {
      expect(matchesTrigger("regex", "^hello\\s+world$", "hello world")).toBe(true);
    });
    it("rejects when the regex doesn't match", () => {
      expect(matchesTrigger("regex", "^foo", "bar")).toBe(false);
    });
    it("supports character classes / quantifiers", () => {
      expect(matchesTrigger("regex", "\\b\\d{4}\\b", "year 2026 update")).toBe(true);
    });
    it("returns false (not throw) when the pattern fails to compile", () => {
      // unclosed group → SyntaxError inside RegExp ctor
      expect(matchesTrigger("regex", "(unclosed", "anything")).toBe(false);
    });
    it("caches compiled regex across calls (same pattern, different content)", () => {
      // No way to read the cache directly, but observably: a malformed
      // pattern keeps returning false on every call rather than
      // somehow recovering.
      expect(matchesTrigger("regex", "(bad", "a")).toBe(false);
      expect(matchesTrigger("regex", "(bad", "b")).toBe(false);
      expect(matchesTrigger("regex", "(bad", "c")).toBe(false);
    });
    it("treats two distinct patterns as separate cache entries", () => {
      expect(matchesTrigger("regex", "^a", "abc")).toBe(true);
      expect(matchesTrigger("regex", "^b", "abc")).toBe(false);
      expect(matchesTrigger("regex", "^a", "abc")).toBe(true);
    });
  });

  describe("unknown patternKind", () => {
    it("returns false for an unrecognised kind", () => {
      // @ts-expect-error — exercising the runtime defensive branch
      expect(matchesTrigger("nonsense", "x", "x")).toBe(false);
    });
  });
});

describe("behavior-trigger.matchTrigger: one match, with its captures", () => {
  it("returns a regex's numbered groups in order", () => {
    expect(matchTrigger("regex", "^天氣\\s+(.+)", "天氣 台北")).toEqual({ captures: ["台北"] });
    expect(matchTrigger("regex", "^!(\\w+)\\s+(?<arg>\\S+)", "!wake box1 now")).toEqual({
      captures: ["wake", "box1"],
    });
  });

  it("an optional group that took no part is null", () => {
    expect(matchTrigger("regex", "^!go( fast)?(!)?$", "!go!")).toEqual({ captures: [null, "!"] });
  });

  it("captures nothing for startswith / endswith or a group-less regex", () => {
    expect(matchTrigger("startswith", "!go", "!go x")).toEqual({ captures: [] });
    expect(matchTrigger("endswith", "?", "why?")).toEqual({ captures: [] });
    expect(matchTrigger("regex", "^!go", "!go")).toEqual({ captures: [] });
  });

  it("is null when nothing matches", () => {
    expect(matchTrigger("regex", "^(x)", "nope")).toBeNull();
    expect(matchTrigger("startswith", "!go", "go")).toBeNull();
  });
});

// #119
describe("behavior-trigger: abuse-proof regexes", () => {
  it("a catastrophic-backtracking pattern on a crafted message answers at once", () => {
    const started = performance.now();
    expect(matchesTrigger("regex", "(a+)+$", "a".repeat(4000) + "!")).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  }, 2_000);

  // whichever of these this process's engine refuses (probed, not assumed)
  const refused = ["(a)\\1", "(?=a)a", "x{1,1000}", "(a+)+"].find(
    (p) => compileTriggerRegex(p) === null,
  );

  it.runIf(refused !== undefined)(
    "a stored pattern this process cannot run never matches, and is logged once",
    () => {
      vi.mocked(botEventLog.record).mockClear();
      const pattern = refused!;
      for (const text of ["aa", "a", "xx"]) expect(matchesTrigger("regex", pattern, text)).toBe(false);
      const warnings = vi
        .mocked(botEventLog.record)
        .mock.calls.filter(([level, , message]) => level === "warn" && message.includes(pattern));
      expect(warnings).toHaveLength(1);
    },
  );

  it("keeps at most 500 compiled patterns", () => {
    for (let i = 0; i < 600; i++) matchesTrigger("regex", `^cache-${i}$`, "x");
    expect(__regexCacheSizeForTests()).toBe(500);
    // the newest still answers
    expect(matchesTrigger("regex", "^cache-599$", "cache-599")).toBe(true);
  });
});
