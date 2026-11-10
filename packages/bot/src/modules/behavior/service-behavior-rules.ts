/**
 * Service Behavior rules (#126): what a service's behavior row may be.
 * Pure; refusals are thrown as BehaviorApiError.
 *
 * A Service Behavior is a bot DM Message Trigger whose action is fixed —
 * mint a Service Token for whoever triggered it and reply privately with
 * the link (service-login-action.ts). Who may log in to the service is
 * exactly who can trigger it, so the trigger is the admin's to choose
 * (pattern, audience); everything else is fixed:
 *
 *   - bot DMs only: the reply carries a token, and a bot DM keeps it
 *     between the bot and the user
 *   - always the end of the walk (it is matched like the login: a closing
 *     action), no reply visibility to choose, no title or note of its own
 *     (both follow the service), never disabled on its own
 *
 * Matching order: Service Behaviors come before the login (sortOrder
 * SERVICE_SORT_ORDER < the login's -1000), because the default trigger
 * `!login-<audience>` starts with the login's default `!login`. That makes
 * a service trigger able to shadow the login, which is the owner's only
 * way in — so a service trigger may never match the login's own pattern
 * text (checkClearOfLogin), and the login's switch refuses a sample a
 * service trigger would take (checkLoginSampleClearOfServices).
 *
 * The default trigger is an exact match, `^!login-<audience>$`: a
 * `startswith` default would let service `foo` take `!login-foo-bar`.
 */

import { BehaviorApiError } from "./behavior-api-error.js";
import { serviceBehaviorsOf, systemLoginOf, type BehaviorCatalog } from "./behavior-catalog.js";
import { matchesTrigger } from "./behavior-trigger.js";
import type { BehaviorPatternKind } from "./models/behavior-definition.model.js";

/** Before the login (-1000) and every custom trigger: see the module comment. */
export const SERVICE_SORT_ORDER = -2000;

/** The fields of a Service Behavior an admin may change: its trigger. */
export const SERVICE_TRIGGER_KEYS = [
  "patternKind",
  "patternValue",
  "audienceKind",
  "audienceUserId",
  "audienceGroupName",
] as const;

export interface ServicePattern {
  patternKind: BehaviorPatternKind;
  patternValue: string;
}

/** The trigger a new service gets: a bot DM of exactly `!login-<audience>`. */
export function defaultServicePattern(audience: string): ServicePattern {
  // an audience is a slug ([a-z0-9-]): nothing in it needs escaping
  return { patternKind: "regex", patternValue: `^!login-${audience}$` };
}

/** The row's title, which follows its service's name. */
export function serviceBehaviorTitle(serviceName: string): string {
  return `登入 ${serviceName}`;
}

export const SERVICE_BEHAVIOR_DESCRIPTION =
  "以觸發者身分簽發這個服務的登入 token，私下回覆登入連結（120 秒、一次性）。服務列：只能改觸發，隨服務新增與刪除。";

/** A PATCH body for a Service Behavior: anything but its trigger is refused. */
export function refuseServiceFields(body: object): void {
  const allowed: readonly string[] = [...SERVICE_TRIGGER_KEYS, "ifUpdatedAt"];
  const field = Object.keys(body).find((k) => !allowed.includes(k));
  if (field !== undefined) {
    throw new BehaviorApiError(
      "system_immutable",
      `a service's behavior only takes trigger changes (${SERVICE_TRIGGER_KEYS.join(", ")}); ${field} is fixed — rename or delete the service on the services page (/api/services)`,
      field,
    );
  }
}

/**
 * The login's own DM text — its pattern, on a message trigger — must still
 * reach the login with this service trigger in front of it.
 */
export function checkClearOfLogin(catalog: BehaviorCatalog, pattern: ServicePattern): void {
  const login = systemLoginOf(catalog);
  if (!login || login.command || login.row.patternValue === null) return;
  if (matchesTrigger(pattern.patternKind, pattern.patternValue, login.row.patternValue)) {
    throw new BehaviorApiError(
      "validation_failed",
      `this trigger also matches "${login.row.patternValue}", the admin login's trigger; service triggers are matched first, so it would take the login's DMs — choose a more specific pattern`,
      "patternValue",
    );
  }
}

/** The login's switch to a message: the DM the admin would send must not be taken by a service. */
export function checkLoginSampleClearOfServices(catalog: BehaviorCatalog, sample: string): void {
  const text = sample.trim();
  const taken = serviceBehaviorsOf(catalog).find(
    (b) =>
      b.patternKind !== null &&
      b.patternValue !== null &&
      matchesTrigger(b.patternKind, b.patternValue, text),
  );
  if (taken) {
    throw new BehaviorApiError(
      "validation_failed",
      `the sample DM would be taken by the trigger of service "${taken.service?.name ?? taken.title}", which is matched before the login; change that trigger or pick another pattern`,
      "sample",
    );
  }
}
