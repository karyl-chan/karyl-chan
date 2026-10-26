/**
 * The Message Trigger rules (ADR 0003), checked against the state a write
 * would leave — a PATCH is merged first, so a change that is fine on its
 * own but wrong with the stored fields (moving a user-audience trigger to
 * a guild) is still refused. Pure; refusals are thrown as
 * `validation_failed` naming the field to fix.
 *
 *   - placement (guildId / channelId) only for surface `guild`; a channel
 *     needs its guild
 *   - audience other than `all` only in bot DMs; its fields match its kind
 *   - `ignoreBots` cannot be turned off in bot DMs — the matcher drops bot
 *     authors there unconditionally (#116)
 *   - a regex pattern must compile
 */

import { BehaviorApiError } from "./behavior-api-error.js";
import { isValidRegex } from "./behavior-helpers.js";
import type {
  BehaviorAudienceKind,
  BehaviorMessageSurface,
  BehaviorPatternKind,
} from "./models/behavior-definition.model.js";

export interface MessageTriggerState {
  surface: BehaviorMessageSurface;
  guildId: string | null;
  channelId: string | null;
  patternKind: BehaviorPatternKind;
  patternValue: string;
  ignoreBots: boolean;
  audienceKind: BehaviorAudienceKind;
  audienceUserId: string | null;
  audienceGroupName: string | null;
}

function refuse(field: string, message: string): never {
  throw new BehaviorApiError("validation_failed", message, field);
}

export function checkMessageTrigger(s: MessageTriggerState): void {
  if (s.surface === "bot_dm") {
    if (s.guildId !== null) refuse("guildId", "a bot DM trigger has no guild");
    if (s.channelId !== null) refuse("channelId", "a bot DM trigger has no channel");
    if (!s.ignoreBots) {
      refuse(
        "ignoreBots",
        "bot authors never reach bot DM triggers; ignoreBots only applies in guilds",
      );
    }
  } else {
    if (s.channelId !== null && s.guildId === null) {
      refuse("channelId", "a channel trigger needs its guildId");
    }
    if (s.audienceKind !== "all") {
      refuse("audienceKind", "an audience other than 'all' only applies to bot DM triggers");
    }
  }

  switch (s.audienceKind) {
    case "all":
      if (s.audienceUserId !== null) refuse("audienceUserId", "audience 'all' takes no user");
      if (s.audienceGroupName !== null) {
        refuse("audienceGroupName", "audience 'all' takes no group");
      }
      break;
    case "user":
      if (s.audienceUserId === null) refuse("audienceUserId", "audience 'user' needs audienceUserId");
      if (s.audienceGroupName !== null) {
        refuse("audienceGroupName", "audience 'user' takes no group");
      }
      break;
    case "group":
      if (s.audienceGroupName === null) {
        refuse("audienceGroupName", "audience 'group' needs audienceGroupName");
      }
      if (s.audienceUserId !== null) refuse("audienceUserId", "audience 'group' takes no user");
      break;
  }

  if (s.patternKind === "regex" && !isValidRegex(s.patternValue)) {
    refuse("patternValue", "the regex does not compile");
  }
}
