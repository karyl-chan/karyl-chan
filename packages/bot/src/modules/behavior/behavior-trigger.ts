import type { BehaviorPatternKind } from "./models/behavior-definition.model.js";
import { checkTriggerRegex, compileTriggerRegex } from "../../utils/linear-regex.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { shouldRecord } from "../bot-events/bot-event-dedup.js";

/**
 * Evaluate whether a message body matches a Message Trigger's pattern
 * (startswith / endswith / regex). Synchronous; safe to call inside the
 * hot path of messageCreate.
 *
 * A regex is written by an admin but its input is any member's message,
 * so it runs on V8's linear-time engine (`compileTriggerRegex`, #119): a
 * crafted message cannot make it backtrack for seconds. A stored pattern
 * this process cannot compile that way (written before the save check,
 * or a Node upgrade changed what the engine accepts) never matches, and
 * says so in the bot event log once.
 *
 * Compiled regexes are cached by source string — the patterns are static
 * between writes, so recompiling per message would be waste. Editing a
 * pattern makes a new entry; at REGEX_CACHE_MAX entries the oldest goes.
 */
const REGEX_CACHE_MAX = 500;
const regexCache = new Map<string, RegExp | null>();

function getRegex(patternValue: string): RegExp | null {
  const cached = regexCache.get(patternValue);
  if (cached !== undefined) return cached;
  const compiled = compileTriggerRegex(patternValue);
  if (compiled === null) warnUnusable(patternValue);
  if (regexCache.size >= REGEX_CACHE_MAX) {
    regexCache.delete(regexCache.keys().next().value as string);
  }
  regexCache.set(patternValue, compiled);
  return compiled;
}

function warnUnusable(patternValue: string): void {
  if (!shouldRecord(`behavior-regex-unusable:${patternValue}`)) return;
  botEventLog.record(
    "warn",
    "bot",
    `behavior-trigger: regex /${patternValue}/ 無法執行（${checkTriggerRegex(patternValue)}），這個觸發不會命中`,
    { patternValue },
  );
}

/** 測試用：快取的 regex 數。 */
export function __regexCacheSizeForTests(): number {
  return regexCache.size;
}

/** A match: a regex trigger's capture groups, empty for the other kinds. */
export interface TriggerMatch {
  /**
   * Group 1 first; a named group counts by its position; null for an
   * optional group that took no part — sent to the webhook as
   * `_meta.captures` (#140).
   */
  captures: Array<string | null>;
}

/** The match, or null — a regex runs once for both (#119). */
export function matchTrigger(
  patternKind: BehaviorPatternKind,
  patternValue: string,
  content: string,
): TriggerMatch | null {
  if (patternKind === "startswith") {
    return content.startsWith(patternValue) ? { captures: [] } : null;
  }
  if (patternKind === "endswith") {
    return content.endsWith(patternValue) ? { captures: [] } : null;
  }
  if (patternKind === "regex") {
    const match = getRegex(patternValue)?.exec(content);
    return match ? { captures: match.slice(1).map((g) => g ?? null) } : null;
  }
  return null;
}

export function matchesTrigger(
  patternKind: BehaviorPatternKind,
  patternValue: string,
  content: string,
): boolean {
  return matchTrigger(patternKind, patternValue, content) !== null;
}
