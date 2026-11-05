/**
 * #119 — trigger regexes run on V8's linear-time engine (the `l` flag)
 * when this Node has it; without it, save-time refuses what safe-regex2
 * calls exponential and the normal engine runs the rest.
 *
 * Which syntax the linear engine accepts differs between V8 versions
 * (lookbehind: no on Node 20, yes on 22 and 24), so these tests assert
 * behaviour from the probe, never a Node-version-specific syntax list.
 */
import { describe, it, expect } from "vitest";
import {
  checkTriggerRegex,
  compileTriggerRegex,
  linearRegexAvailable,
} from "../src/utils/linear-regex.js";

/** Whether this process's linear engine takes `pattern` — asked of V8 directly. */
function linearEngineTakes(pattern: string): boolean {
  try {
    new RegExp(pattern, "l");
    return true;
  } catch {
    return false;
  }
}

describe("the probe", () => {
  it("reports the linear engine as available exactly when an `l` regex compiles", () => {
    expect(linearRegexAvailable).toBe(linearEngineTakes("a"));
  });
});

describe.runIf(linearRegexAvailable)("with the linear engine", () => {
  it("compiles an ordinary pattern with the `l` flag", () => {
    const re = compileTriggerRegex("^天氣\\s+(.+)");
    expect(re?.flags).toContain("l");
    expect(re?.exec("天氣 台北")?.slice(1)).toEqual(["台北"]);
  });

  it("(a+)+$ is either compiled for linear time or refused, and never hangs", () => {
    const input = "a".repeat(4000) + "!";
    const started = performance.now();
    const re = compileTriggerRegex("(a+)+$");
    if (re) expect(re.test(input)).toBe(false);
    else expect(checkTriggerRegex("(a+)+$")).toBe("not_linear");
    expect(performance.now() - started).toBeLessThan(100);
  }, 2_000);

  it.each([
    ["a backreference", "(a)\\1"],
    ["a lookahead", "(?=a)a"],
    ["a large repeat count", "x{1,1000}"],
  ])("refuses %s exactly when the engine cannot run it", (_what, pattern) => {
    const expected = linearEngineTakes(pattern) ? null : "not_linear";
    expect(checkTriggerRegex(pattern)).toBe(expected);
    expect(compileTriggerRegex(pattern) === null).toBe(expected !== null);
  });

  it("a pattern that does not compile at all is a syntax error, not a linear-time one", () => {
    expect(checkTriggerRegex("(unclosed")).toBe("syntax");
    expect(compileTriggerRegex("(unclosed")).toBeNull();
  });
});

describe("without the linear engine (the fallback)", () => {
  const linear = false;

  it("refuses a nested repeat that safe-regex2 calls exponential", () => {
    expect(checkTriggerRegex("(a+)+", linear)).toBe("unsafe");
    expect(compileTriggerRegex("(a+)+", linear)).toBeNull();
  });

  it("accepts an ordinary pattern and runs it on the normal engine", () => {
    expect(checkTriggerRegex("^!ping\\s+(\\w+)", linear)).toBeNull();
    const re = compileTriggerRegex("^!ping\\s+(\\w+)", linear);
    expect(re?.flags).not.toContain("l");
    expect(re?.exec("!ping box1")?.slice(1)).toEqual(["box1"]);
  });

  it("keeps what only the linear engine refuses, like a backreference", () => {
    expect(checkTriggerRegex("(a)\\1", linear)).toBeNull();
  });

  it("a pattern that does not compile is still a syntax error", () => {
    expect(checkTriggerRegex("(unclosed", linear)).toBe("syntax");
  });
});
