/**
 * Trigger regexes that cannot hang the event loop (#119).
 *
 * A Message Trigger's regex is written by an admin but runs on every
 * matching message anyone sends, so one catastrophic-backtracking
 * pattern (`(a+)+$`) plus one crafted message would stall the whole
 * process, the owner's `!login` included. V8 ships a non-backtracking
 * engine that runs a regex in time linear in its input; a regex opts in
 * with the `l` flag, which needs `--enable-experimental-regexp-engine`.
 *
 * The flag is set here, at module load, rather than on the command line:
 * `NODE_OPTIONS` refuses V8 flags, and this way vitest, `pnpm dev` and
 * Docker all behave alike. The engine refuses at compile time what it
 * cannot run in linear time; which syntax that is depends on the V8
 * version (Node 20 refuses lookbehind, Node 22 and 24 take it), so the
 * engine is probed and asked, never assumed.
 *
 * Without the engine (a Node whose V8 dropped the experimental flag)
 * trigger regexes fall back to the normal engine, and only what
 * safe-regex2 judges safe (star height 1) is accepted — weaker, but the
 * bot keeps running. Either way a pattern compiles here exactly when
 * `checkTriggerRegex` accepts it, so the runtime runs only what a save
 * would accept.
 */

import v8 from "node:v8";
import safeRegex from "safe-regex2";

function probeLinearEngine(): boolean {
  try {
    v8.setFlagsFromString("--enable-experimental-regexp-engine");
    return new RegExp("a", "l").flags.includes("l");
  } catch {
    return false;
  }
}

/** Whether this process runs trigger regexes on V8's linear-time engine. */
export const linearRegexAvailable: boolean = probeLinearEngine();

/**
 * Why a trigger regex is refused:
 *   - `syntax` — it is not a regex at all
 *   - `not_linear` — it uses syntax the linear-time engine cannot run
 *     (backreferences, lookahead, large repeat counts)
 *   - `unsafe` — without the linear engine: safe-regex2 says it may take
 *     exponential time (a repeat inside a repeat)
 */
export type TriggerRegexRefusal = "syntax" | "not_linear" | "unsafe";

type Compiled = { regex: RegExp } | { refusal: TriggerRegexRefusal };

function compile(pattern: string, linear: boolean): Compiled {
  if (linear) {
    try {
      return { regex: new RegExp(pattern, "l") };
    } catch {
      // only a pattern that compiles normally is a linear-time refusal
    }
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return { refusal: "syntax" };
  }
  if (linear) return { refusal: "not_linear" };
  return safeRegex(pattern) ? { regex } : { refusal: "unsafe" };
}

/**
 * A trigger's regex ready to run, or null when `checkTriggerRegex`
 * refuses it (such a trigger never matches). `linear` defaults to what
 * this process supports; tests pass it to run the other mode.
 */
export function compileTriggerRegex(
  pattern: string,
  linear: boolean = linearRegexAvailable,
): RegExp | null {
  const compiled = compile(pattern, linear);
  return "regex" in compiled ? compiled.regex : null;
}

/** Why a trigger's regex would be refused, or null when it is accepted. */
export function checkTriggerRegex(
  pattern: string,
  linear: boolean = linearRegexAvailable,
): TriggerRegexRefusal | null {
  const compiled = compile(pattern, linear);
  return "refusal" in compiled ? compiled.refusal : null;
}
