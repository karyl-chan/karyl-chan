/**
 * Service Behavior rules (#126): what a service's behavior row may be.
 * Pure; refusals are thrown as BehaviorApiError.
 *
 * A Service Behavior is a fixed row like the System Behavior: its action
 * is the service's login — mint a Service Token for whoever triggered it
 * and reply privately with the link (service-login-action.ts) — and its
 * trigger is the one thing the owner changes, through the same fixed-row
 * switch as the login (fixed-trigger-switch.ts):
 *
 *   - a bot DM Message Trigger: any pattern kind, and an audience — who
 *     may log in to the service is exactly who can trigger it. Never a
 *     guild channel: the reply carries a token, and a bot DM keeps it
 *     between the bot and the user. It always ends the walk.
 *   - or a global Command (no default member permissions; installs and
 *     contexts as Discord allows): its reply is ephemeral. `/login` stays
 *     the system login's.
 *
 * Matching order: Service Behaviors come before the login (sortOrder
 * SERVICE_SORT_ORDER < the login's -1000), because the default trigger
 * `!login-<audience>` starts with the login's default `!login`. A service
 * trigger could therefore shadow the login, the owner's only way in — so
 * one invariant is kept from both sides: no service message trigger
 * matches the login's own DM (its pattern text, and the sample its switch
 * was given). A service save checks it against the login's pattern
 * (checkServiceTriggerClear); the login's switch checks its pattern and
 * its sample against every service trigger (checkLoginClearOfServices).
 *
 * Services do not shadow each other either: a service trigger may not
 * match another service's sample DM, nor be matched by another's trigger.
 * A service's sample DM is its pattern text for `startswith` / `endswith`,
 * or `!login-<audience>` while it is on the default. The default is an
 * exact match, `^!login-<audience>$`, so two defaults never overlap.
 */

import { BehaviorApiError } from "./behavior-api-error.js";
import {
  serviceBehaviorsOf,
  systemLoginOf,
  type BehaviorCatalog,
  type FixedRowEntry,
} from "./behavior-catalog.js";
import { matchesTrigger } from "./behavior-trigger.js";
import { checkCommandSettings } from "./command-tree-rules.js";
import { globalCommandSettings, type FixedTrigger } from "./fixed-trigger-switch.js";
import { checkMessageTrigger } from "./message-trigger-rules.js";
import type {
  BehaviorAudienceKind,
  BehaviorPatternKind,
} from "./models/behavior-definition.model.js";
import type { DiscordContext, DiscordIntegrationType } from "../../utils/command-axes.js";

/** Before the login (-1000) and every custom trigger: see the module comment. */
export const SERVICE_SORT_ORDER = -2000;

export interface ServicePattern {
  patternKind: BehaviorPatternKind;
  patternValue: string;
}

/** The trigger a new service gets: a bot DM of exactly `!login-<audience>`. */
export function defaultServicePattern(audience: string): ServicePattern {
  // an audience is a slug ([a-z0-9-]): nothing in it needs escaping
  return { patternKind: "regex", patternValue: `^!login-${audience}$` };
}

export const SERVICE_BEHAVIOR_DESCRIPTION =
  "以觸發者身分簽發這個服務的登入 token，私下回覆登入連結（120 秒、一次性）。服務列：只能改觸發，隨服務新增與刪除。";

/** What a command trigger offers when the body does not say: DMs with the bot, as the login. */
export const SERVICE_COMMAND_DEFAULTS = {
  integrationTypes: ["guild_install"] as DiscordIntegrationType[],
  contexts: ["BotDM"] as DiscordContext[],
};

// ── the trigger a body asks for ─────────────────────────────────────────────

/** The request body of PUT /api/services/:id/trigger. */
export interface ServiceTriggerBody {
  kind: "message" | "command";
  patternKind?: BehaviorPatternKind;
  patternValue?: string;
  audienceKind?: BehaviorAudienceKind;
  audienceUserId?: string | null;
  audienceGroupName?: string | null;
  name?: string;
  description?: string;
  integrationTypes?: DiscordIntegrationType[];
  contexts?: DiscordContext[];
  ifUpdatedAt?: string;
}

const MESSAGE_FIELDS = [
  "patternKind",
  "patternValue",
  "audienceKind",
  "audienceUserId",
  "audienceGroupName",
] as const;
const COMMAND_FIELDS = ["name", "description", "integrationTypes", "contexts"] as const;

function refuse(field: string, message: string): never {
  throw new BehaviorApiError("validation_failed", message, field);
}

/** A request body → the trigger it asks for, every rule but the shadowing checked. */
export function serviceTriggerOf(body: ServiceTriggerBody): FixedTrigger {
  const own: readonly string[] = body.kind === "message" ? MESSAGE_FIELDS : COMMAND_FIELDS;
  const foreign = [...MESSAGE_FIELDS, ...COMMAND_FIELDS].find(
    (k) => !own.includes(k) && body[k] !== undefined,
  );
  if (foreign !== undefined) refuse(foreign, `${foreign} does not apply to a ${body.kind} trigger`);

  if (body.kind === "message") {
    if (body.patternKind === undefined) refuse("patternKind", "patternKind is required");
    if (body.patternValue === undefined) refuse("patternValue", "patternValue is required");
    const trigger = {
      kind: "message" as const,
      patternKind: body.patternKind,
      patternValue: body.patternValue,
      audienceKind: body.audienceKind ?? "all",
      audienceUserId: body.audienceUserId ?? null,
      audienceGroupName: body.audienceGroupName?.trim() ?? null,
    };
    checkMessageTrigger({ ...trigger, surface: "bot_dm", guildId: null, channelId: null, ignoreBots: true });
    return trigger;
  }

  if (body.name === undefined) refuse("name", "name is required");
  if (body.description === undefined) refuse("description", "description is required");
  const settings = globalCommandSettings({
    name: body.name,
    description: body.description.trim(),
    integrationTypes: body.integrationTypes ?? [...SERVICE_COMMAND_DEFAULTS.integrationTypes],
    contexts: body.contexts ?? [...SERVICE_COMMAND_DEFAULTS.contexts],
  });
  checkCommandSettings(settings);
  return { kind: "command", settings };
}

// ── shadowing ───────────────────────────────────────────────────────────────

/** The DMs a service's trigger is sure to answer (see the module comment). */
function sampleDmsOf(audience: string, pattern: ServicePattern): string[] {
  if (pattern.patternKind !== "regex") return [pattern.patternValue];
  const fallback = defaultServicePattern(audience);
  return pattern.patternValue === fallback.patternValue ? [`!login-${audience}`] : [];
}

function patternOf(entry: FixedRowEntry): ServicePattern | null {
  const { row } = entry;
  if (entry.command || row.patternKind === null || row.patternValue === null) return null;
  return { patternKind: row.patternKind, patternValue: row.patternValue };
}

function nameOf(entry: FixedRowEntry): string {
  return entry.row.service?.name ?? entry.row.title;
}

/**
 * A service's message trigger `pattern` (for audience `audience`; the
 * service's own row is `serviceId`, null while creating it) takes no
 * other fixed row's DMs and is taken by no other service's trigger.
 */
export function checkServiceTriggerClear(
  catalog: BehaviorCatalog,
  serviceId: number | null,
  audience: string,
  pattern: ServicePattern,
): void {
  const login = systemLoginOf(catalog);
  if (login && !login.command && login.row.patternValue !== null) {
    if (matchesTrigger(pattern.patternKind, pattern.patternValue, login.row.patternValue)) {
      refuse(
        "patternValue",
        `this trigger also matches "${login.row.patternValue}", the admin login's trigger; service triggers are matched first, so it would take the login's DMs — choose a more specific pattern`,
      );
    }
  }
  const own = sampleDmsOf(audience, pattern);
  for (const other of serviceBehaviorsOf(catalog)) {
    if (other.row.serviceId === serviceId || !other.row.service) continue;
    const theirs = patternOf(other);
    if (!theirs) continue;
    const taken = sampleDmsOf(other.row.service.audience, theirs).find((dm) =>
      matchesTrigger(pattern.patternKind, pattern.patternValue, dm),
    );
    if (taken !== undefined) {
      refuse(
        "patternValue",
        `this trigger also matches "${taken}", the trigger of service "${nameOf(other)}"; choose a more specific pattern`,
      );
    }
    const takenBy = own.find((dm) => matchesTrigger(theirs.patternKind, theirs.patternValue, dm));
    if (takenBy !== undefined) {
      refuse(
        "patternValue",
        `"${takenBy}" would be answered by the trigger of service "${nameOf(other)}"; change that trigger or choose another pattern`,
      );
    }
  }
}

/** The login's switch to a message: no service trigger may take its pattern or its sample DM. */
export function checkLoginClearOfServices(
  catalog: BehaviorCatalog,
  dms: { patternValue: string; sample: string },
): void {
  for (const [field, text] of [
    ["patternValue", dms.patternValue],
    ["sample", dms.sample.trim()],
  ] as const) {
    const taken = serviceBehaviorsOf(catalog).find((entry) => {
      const pattern = patternOf(entry);
      return pattern !== null && matchesTrigger(pattern.patternKind, pattern.patternValue, text);
    });
    if (taken) {
      refuse(
        field,
        `"${text}" would be taken by the trigger of service "${nameOf(taken)}", which is matched before the login; change that trigger or pick another pattern`,
      );
    }
  }
}
