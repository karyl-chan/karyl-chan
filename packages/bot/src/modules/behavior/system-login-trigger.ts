/**
 * The System Behavior's trigger (ADR 0003 System Behavior, #139): what the
 * login may be switched to. Pure; refusals are thrown as BehaviorApiError.
 *
 * The login is the owner's only way into the admin UI, so every rule here
 * answers one question: after this save, can the owner still log in?
 *
 * The login is either a Message Trigger or a Command, never both:
 *
 *   - Message Trigger: bot DMs only (a reply in a guild channel is public,
 *     and the reply carries the login link), audience `all` (who may log
 *     in is the action's call — it checks authorisation), always stops
 *     the walk. The pattern must be something an admin can actually send:
 *       - `startswith` or `endswith` — never a regex. A regex can be
 *         written to never match (`(?!)`), can be slow on every DM (the
 *         login is matched first, sortOrder -1000), and the public login
 *         page would show it verbatim.
 *       - not blank, no leading or trailing whitespace — Discord trims a
 *         message, so such a pattern can never match
 *       - a `sample` DM the admin would send must match it, through the
 *         matcher's own `matchesTrigger` (on the sample as Discord delivers
 *         it: trimmed). That catches the case slip, the mention that
 *         arrives as `<@id>`, the typo — before the save, not after logout.
 *   - Command: a global command (a guild command dies with the guild —
 *     the bot leaving it would lock every admin out), no default member
 *     permissions (they only apply in guilds and would hide the login
 *     from admins without them there). Its install types must include
 *     `guild_install` and its contexts `BotDM`: Discord accepts a command
 *     installed by users only, or usable in guilds only, but the owner
 *     who has not installed the app, or shares no guild with the bot,
 *     would never see it. Anything else Discord's rules allow may be added
 *     (command-tree-rules.ts): every context is safe, as the login replies
 *     ephemerally (only the invoker sees the link) and checks
 *     authorisation. Default: exactly `BotDM` with `guild_install` — the
 *     login stays where it always was, in DMs with the bot.
 *
 * The name `/login` is reserved for the system login (#96): other commands
 * cannot take it, the login can. Any other name must be free in the
 * shared command namespace like every command's. That check runs inside
 * the reconcile lock, but a plugin registering the same name concurrently
 * does not take the behavior write lock: a plugin command that lands
 * between the check and the registration would be patched over. Plugin
 * registration is rare and the window is one Discord round trip, so it is
 * accepted rather than locked against.
 */

import { BehaviorApiError } from "./behavior-api-error.js";
import { matchesTrigger } from "./behavior-trigger.js";
import { checkCommandSettings } from "./command-tree-rules.js";
import type { DiscordContext, DiscordIntegrationType } from "../../utils/command-axes.js";
import type { BehaviorPatternKind } from "./models/behavior-definition.model.js";

/** The pattern kinds the login's message trigger may use. */
export type LoginPatternKind = Exclude<BehaviorPatternKind, "regex">;
export const LOGIN_PATTERN_KINDS: readonly LoginPatternKind[] = ["startswith", "endswith"];

export interface LoginMessageTrigger {
  kind: "message";
  patternKind: LoginPatternKind;
  patternValue: string;
}

export interface LoginCommandTrigger {
  kind: "command";
  name: string;
  description: string;
  integrationTypes: DiscordIntegrationType[];
  contexts: DiscordContext[];
}

export type LoginTrigger = LoginMessageTrigger | LoginCommandTrigger;

/** What the login command must always offer, so the owner can reach it. */
export const LOGIN_COMMAND_REQUIRED = {
  integrationType: "guild_install" as DiscordIntegrationType,
  context: "BotDM" as DiscordContext,
};

export const LOGIN_COMMAND_DEFAULTS = {
  integrationTypes: [LOGIN_COMMAND_REQUIRED.integrationType],
  contexts: [LOGIN_COMMAND_REQUIRED.context],
};

/** The request body of PUT /api/behaviors/system/login/trigger. */
export interface LoginTriggerBody {
  kind: "message" | "command";
  patternKind?: BehaviorPatternKind;
  patternValue?: string;
  /** A DM the admin would send to log in; must match the pattern. Message only, not stored. */
  sample?: string;
  name?: string;
  description?: string;
  integrationTypes?: DiscordIntegrationType[];
  contexts?: DiscordContext[];
  ifUpdatedAt?: string;
}

const MESSAGE_FIELDS = ["patternKind", "patternValue", "sample"] as const;
const COMMAND_FIELDS = ["name", "description", "integrationTypes", "contexts"] as const;

function refuse(field: string, message: string): never {
  throw new BehaviorApiError("validation_failed", message, field);
}

export function checkLoginPattern(
  patternKind: BehaviorPatternKind,
  patternValue: string,
  sample: string,
): asserts patternKind is LoginPatternKind {
  if (!(LOGIN_PATTERN_KINDS as readonly string[]).includes(patternKind)) {
    refuse(
      "patternKind",
      "the login's message trigger takes startswith or endswith, not a regex (one can be written to never match, runs on every DM, and the public login page would show it)",
    );
  }
  if (patternValue.trim() === "") refuse("patternValue", "patternValue must not be blank");
  if (patternValue !== patternValue.trim()) {
    refuse(
      "patternValue",
      "Discord trims the spaces around a message, so a pattern starting or ending with whitespace never matches",
    );
  }
  // as the bot receives it: Discord trims a message's content
  if (!matchesTrigger(patternKind, patternValue, sample.trim())) {
    refuse(
      "sample",
      "the sample DM does not match the pattern, so sending it would not log you in; fix the pattern or the sample",
    );
  }
}

function checkLoginCommandReach(trigger: LoginCommandTrigger): void {
  if (!trigger.integrationTypes.includes(LOGIN_COMMAND_REQUIRED.integrationType)) {
    refuse(
      "integrationTypes",
      "the login command must be installed with the server (guild_install): installed by users only, it is invisible to an owner who has not installed the app",
    );
  }
  if (!trigger.contexts.includes(LOGIN_COMMAND_REQUIRED.context)) {
    refuse(
      "contexts",
      "the login command must be usable in DMs with the bot (BotDM): elsewhere only, an owner sharing no server with the bot cannot reach it",
    );
  }
}

/** A request body → the trigger it asks for, every rule checked. */
export function loginTriggerOf(body: LoginTriggerBody): LoginTrigger {
  const own: readonly string[] = body.kind === "message" ? MESSAGE_FIELDS : COMMAND_FIELDS;
  const foreign = [...MESSAGE_FIELDS, ...COMMAND_FIELDS].find(
    (k) => !own.includes(k) && body[k] !== undefined,
  );
  if (foreign !== undefined) {
    refuse(foreign, `${foreign} does not apply to a ${body.kind} trigger`);
  }

  if (body.kind === "message") {
    if (body.patternKind === undefined) refuse("patternKind", "patternKind is required");
    if (body.patternValue === undefined) refuse("patternValue", "patternValue is required");
    if (body.sample === undefined || body.sample.trim() === "") {
      refuse("sample", "sample is required: a DM you would send to log in, checked against the pattern");
    }
    const { patternKind, patternValue } = body;
    checkLoginPattern(patternKind, patternValue, body.sample);
    return { kind: "message", patternKind, patternValue };
  }

  if (body.name === undefined) refuse("name", "name is required");
  if (body.description === undefined) refuse("description", "description is required");
  const trigger: LoginCommandTrigger = {
    kind: "command",
    name: body.name,
    description: body.description.trim(),
    integrationTypes: body.integrationTypes ?? [...LOGIN_COMMAND_DEFAULTS.integrationTypes],
    contexts: body.contexts ?? [...LOGIN_COMMAND_DEFAULTS.contexts],
  };
  checkLoginCommandReach(trigger);
  checkCommandSettings({
    name: trigger.name,
    description: trigger.description,
    registration: "global",
    guildId: null,
    integrationTypes: trigger.integrationTypes,
    contexts: trigger.contexts,
  });
  return trigger;
}
