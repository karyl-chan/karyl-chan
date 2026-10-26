import type { BehaviorPatternKind } from "./models/behavior-definition.model.js";

/**
 * Evaluate whether a message body matches a Message Trigger's pattern
 * (startswith / endswith / regex). Pure / synchronous; safe to call inside
 * the hot path of messageCreate.
 *
 * Regex patterns are compiled once and cached — every DM message that
 * passes through the matcher would otherwise pay an O(N_patterns)
 * compilation tax even though the patterns are static between writes
 * to the behaviors table. The cache is keyed by source string;
 * updating a behavior's pattern produces a new key so a stale entry
 * is never reused.
 *
 * NB the ReDoS surface is bounded by the trust model: only admin
 * operators with `behavior.manage` can author regex patterns, and
 * they're authoring against their own bot. A catastrophic
 * backtracking pattern is a self-DoS, not an external attack.
 */
const regexCache = new Map<string, RegExp | null>();

function getRegex(patternValue: string): RegExp | null {
  const cached = regexCache.get(patternValue);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(patternValue);
  } catch {
    compiled = null;
  }
  regexCache.set(patternValue, compiled);
  return compiled;
}

export function matchesTrigger(
  patternKind: BehaviorPatternKind,
  patternValue: string,
  content: string,
): boolean {
  if (patternKind === "startswith") {
    return content.startsWith(patternValue);
  }
  if (patternKind === "endswith") {
    return content.endsWith(patternValue);
  }
  if (patternKind === "regex") {
    const re = getRegex(patternValue);
    return re !== null && re.test(content);
  }
  return false;
}

/**
 * The capture groups of a regex trigger's match, in order (group 1 first;
 * a named group counts by its position; null for an optional group that
 * took no part) — sent to the webhook as `_meta.captures` (#140). Empty
 * for startswith / endswith, a regex without groups, or no match.
 */
export function triggerCaptures(
  patternKind: BehaviorPatternKind,
  patternValue: string,
  content: string,
): Array<string | null> {
  if (patternKind !== "regex") return [];
  const match = getRegex(patternValue)?.exec(content);
  return match ? match.slice(1).map((g) => g ?? null) : [];
}
