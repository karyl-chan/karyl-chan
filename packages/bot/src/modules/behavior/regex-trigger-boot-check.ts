/**
 * Boot check of the regex triggers (#119), run once from startup: what
 * they will not do on this process, in the bot event log, before the
 * first message instead of after.
 *
 *   - no linear-time engine (V8 dropped the experimental flag): regex
 *     triggers run degraded — the normal backtracking engine, and only
 *     what safe-regex2 accepts, at save time and at runtime alike. A
 *     stored pattern with a repeat inside a repeat is disabled (never
 *     matches) and listed by the next point.
 *   - a stored regex trigger the save check now refuses (saved before it
 *     existed, a Node upgrade changed what the engine accepts, or a
 *     nested repeat in degraded mode): it never matches, and is listed
 *     here one by one
 */

import { BehaviorDefinition } from "./models/behavior-definition.model.js";
import { botEventLog } from "../bot-events/bot-event-log.js";
import { checkTriggerRegex, linearRegexAvailable } from "../../utils/linear-regex.js";

/** `linear` defaults to what this process supports; tests pass it. */
export async function checkRegexTriggersAtBoot(
  linear: boolean = linearRegexAvailable,
): Promise<void> {
  if (!linear) {
    botEventLog.record(
      "warn",
      "bot",
      "behavior: V8 的 linear-time regex 引擎不可用，regex 觸發降級執行（一般引擎，存檔與執行時都以 safe-regex2 檢查）；已存的巢狀重複 pattern 會停用（不命中），以下逐筆列出",
    );
  }
  const rows = await BehaviorDefinition.findAll({
    where: { triggerKind: "message", patternKind: "regex" },
  });
  for (const row of rows) {
    const behaviorId = row.getDataValue("id") as number;
    const patternValue = row.getDataValue("patternValue") as string;
    const refusal = checkTriggerRegex(patternValue, linear);
    if (refusal === null) continue;
    botEventLog.record(
      "warn",
      "bot",
      `behavior: regex 觸發 ${behaviorId} 的 /${patternValue}/ 無法執行（${refusal}），不會命中；請改寫`,
      { behaviorId, patternValue, refusal },
    );
  }
}
