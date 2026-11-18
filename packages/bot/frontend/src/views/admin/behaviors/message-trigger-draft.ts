import type {
    BehaviorAudienceKind,
    BehaviorPatch,
    BehaviorPatternKind,
    BehaviorTargetKey,
    BehaviorTargetView,
    MessageTriggerInput,
    MessageTriggerView,
    ReplyVisibility,
} from '../../../api/behavior';
import type { DraftModel } from './draft-rebase';
import { kindHasGuild, locationKindOf, type LocationKind, type TriggerLocation } from './message-trigger-location';
import {
    NEW_ACTION,
    actionBody,
    actionChanged,
    actionDraftOf,
    actionPartOf,
    savedActionBody,
    type ActionBody,
    type ActionDraft,
} from './webhook-draft';

/**
 * The edit draft of a Message Trigger: what the trigger and action forms
 * edit, apart from the saved trigger it started from.
 *
 * The draft holds what the form shows (ids as text, '' = empty); the
 * request body is derived from it, so the form can never send a field
 * that does not apply where the trigger is (an audience in a guild, a
 * guild for a bot DM) — the cross-field rules of message-trigger-rules.ts
 * are kept by construction, the per-field rules by the server's schema.
 */

export interface MessageTriggerDraft extends ActionDraft {
    title: string;
    description: string;
    locationKind: LocationKind;
    guildId: string;
    channelId: string;
    patternKind: BehaviorPatternKind;
    patternValue: string;
    stopOnMatch: boolean;
    ignoreBots: boolean;
    audienceKind: BehaviorAudienceKind;
    audienceUserId: string;
    audienceGroupName: string;
    /** Who the reply is for when the response does not say; null = the location's default. */
    replyVisibility: ReplyVisibility | null;
}

export function draftFromTrigger(t: MessageTriggerView): MessageTriggerDraft {
    return {
        title: t.title,
        description: t.description,
        locationKind: locationKindOf(t),
        guildId: t.guildId ?? '',
        channelId: t.channelId ?? '',
        patternKind: t.patternKind,
        patternValue: t.patternValue,
        stopOnMatch: t.stopOnMatch,
        ignoreBots: t.ignoreBots,
        audienceKind: t.audienceKind,
        audienceUserId: t.audienceUserId ?? '',
        audienceGroupName: t.audienceGroupName ?? '',
        replyVisibility: t.replyVisibility,
        ...actionDraftOf(t),
    };
}

export function emptyDraft(location: { kind: LocationKind; guildId?: string; channelId?: string }): MessageTriggerDraft {
    return {
        title: '',
        description: '',
        locationKind: location.kind,
        guildId: location.guildId ?? '',
        channelId: location.channelId ?? '',
        patternKind: 'startswith',
        patternValue: '',
        stopOnMatch: false,
        ignoreBots: true,
        audienceKind: 'all',
        audienceUserId: '',
        audienceGroupName: '',
        replyVisibility: null,
        ...NEW_ACTION,
    };
}

/** The draft fields that say where a trigger is and for whom — together, its Behavior Target. */
type TargetFields = Pick<
    MessageTriggerDraft,
    'locationKind' | 'guildId' | 'channelId' | 'audienceKind' | 'audienceUserId' | 'audienceGroupName'
>;

/**
 * The Behavior Target a draft's fields add up to (ADR 0004): a user's or
 * a group's for a bot DM trigger with that audience, else its location.
 * Null while a server or channel id it needs is still empty. The server
 * derives a saved trigger's target the same way (behavior-target.ts).
 */
export function draftTarget(d: TargetFields): BehaviorTargetKey | null {
    const guildId = d.guildId.trim();
    const channelId = d.channelId.trim();
    switch (d.locationKind) {
        case 'bot_dm': {
            const userId = d.audienceUserId.trim();
            const groupName = d.audienceGroupName.trim();
            if (d.audienceKind === 'user' && userId) return `user:${userId}`;
            if (d.audienceKind === 'group' && groupName) return `group:${groupName}`;
            return 'bot_dm';
        }
        case 'guild_all':
            return 'guild:all';
        case 'guild':
            return guildId ? `guild:${guildId}` : null;
        case 'channel':
            return guildId && channelId ? `channel:${guildId}:${channelId}` : null;
    }
}

/**
 * The fields that put a draft in `target`: its location, and — for a user
 * or a group — its audience. A target the form may not choose (App 指令,
 * which holds no message trigger) changes nothing.
 */
export function withTarget(draft: MessageTriggerDraft, target: BehaviorTargetView): Partial<MessageTriggerDraft> {
    const everyone = { audienceKind: 'all', audienceUserId: '', audienceGroupName: '' } as const;
    // the matcher drops bot authors in bot DMs whatever the flag says
    const botDm = { locationKind: 'bot_dm', guildId: '', channelId: '', ignoreBots: true } as const;
    switch (target.kind) {
        case 'app':
            return {};
        case 'bot_dm':
            return { ...botDm, ...everyone };
        case 'user':
            return { ...botDm, ...everyone, audienceKind: 'user', audienceUserId: target.userId ?? '' };
        case 'group':
            return { ...botDm, ...everyone, audienceKind: 'group', audienceGroupName: target.groupName ?? '' };
        case 'guild_all':
            return { locationKind: 'guild_all', guildId: '', channelId: '', ...everyone };
        case 'guild':
            return { locationKind: 'guild', guildId: target.guildId ?? '', channelId: '', ...everyone };
        case 'channel':
            return {
                locationKind: 'channel',
                guildId: target.guildId ?? '',
                channelId: target.channelId ?? '',
                ...everyone,
            };
    }
}

/** Where the draft puts the trigger; null while an id it needs is still empty. */
export function draftLocation(d: MessageTriggerDraft): TriggerLocation | null {
    const guildId = d.guildId.trim();
    const channelId = d.channelId.trim();
    switch (d.locationKind) {
        case 'bot_dm':
        case 'guild_all':
            return { kind: d.locationKind };
        case 'guild':
            return guildId ? { kind: 'guild', guildId } : null;
        case 'channel':
            return guildId && channelId ? { kind: 'channel', guildId, channelId } : null;
    }
}

/** The trigger fields of a request body (everything but the action). */
type TriggerBody = Omit<MessageTriggerInput, 'webhook' | 'pluginAction' | 'enabled'> & {
    description: string;
    guildId: string | null;
    channelId: string | null;
    stopOnMatch: boolean;
    ignoreBots: boolean;
    audienceKind: BehaviorAudienceKind;
    audienceUserId: string | null;
    audienceGroupName: string | null;
    replyVisibility: ReplyVisibility | null;
};

export type MessageTriggerBody = TriggerBody & ActionBody;

export function toCreateBody(d: MessageTriggerDraft): MessageTriggerBody {
    const inDm = d.locationKind === 'bot_dm';
    const audienceKind = inDm ? d.audienceKind : 'all';
    return {
        title: d.title.trim(),
        description: d.description.trim(),
        surface: inDm ? 'bot_dm' : 'guild',
        // an empty id stays '' (not null): the schema then names the field
        guildId: kindHasGuild(d.locationKind) ? d.guildId.trim() : null,
        channelId: d.locationKind === 'channel' ? d.channelId.trim() : null,
        patternKind: d.patternKind,
        patternValue: d.patternValue,
        stopOnMatch: d.stopOnMatch,
        ignoreBots: inDm ? true : d.ignoreBots,
        audienceKind,
        audienceUserId: audienceKind === 'user' ? d.audienceUserId.trim() : null,
        audienceGroupName: audienceKind === 'group' ? d.audienceGroupName.trim() : null,
        // nothing to choose in a DM with the bot
        replyVisibility: inDm ? null : d.replyVisibility,
        ...actionBody(d),
    };
}

function savedBody(t: MessageTriggerView): MessageTriggerBody {
    return {
        title: t.title,
        description: t.description,
        surface: t.surface,
        guildId: t.guildId,
        channelId: t.channelId,
        patternKind: t.patternKind,
        patternValue: t.patternValue,
        stopOnMatch: t.stopOnMatch,
        ignoreBots: t.ignoreBots,
        audienceKind: t.audienceKind,
        audienceUserId: t.audienceUserId,
        audienceGroupName: t.audienceGroupName,
        replyVisibility: t.replyVisibility,
        ...savedActionBody(t),
    };
}

/**
 * The PATCH for saving `draft` over `saved`: only the changed fields, the
 * whole action when it changed (its URL or authentication, its plugin
 * action, or its source — the other kind converts the behavior, #203),
 * and the version the edit is based on. Null when the draft changes nothing.
 */
export function toPatchBody(saved: MessageTriggerView, draft: MessageTriggerDraft): BehaviorPatch | null {
    const before = savedBody(saved);
    const after = toCreateBody(draft);
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(after) as Array<keyof MessageTriggerBody>) {
        if (key === 'webhook' || key === 'pluginAction') continue;
        if (after[key] !== before[key]) patch[key] = after[key];
    }
    if (actionChanged(actionPartOf(after), actionPartOf(before))) Object.assign(patch, actionPartOf(after));
    if (Object.keys(patch).length === 0) return null;
    return { ...(patch as BehaviorPatch), ifUpdatedAt: saved.updatedAt };
}

/**
 * Whether a message would fire the pattern — the same test the bot makes
 * (behavior-trigger.ts `matchesTrigger`); 'invalid' for a regex that does
 * not compile. The bot runs a regex on V8's linear-time engine, which a
 * browser does not have (#119): a regex it cannot run there (a
 * backreference, a lookahead) previews normally here, and the save is
 * refused with the bot's reason on the pattern field.
 */
export function previewMatch(kind: BehaviorPatternKind, pattern: string, text: string): 'match' | 'no_match' | 'invalid' {
    if (kind === 'startswith') return text.startsWith(pattern) ? 'match' : 'no_match';
    if (kind === 'endswith') return text.endsWith(pattern) ? 'match' : 'no_match';
    let re: RegExp;
    try {
        re = new RegExp(pattern);
    } catch {
        return 'invalid';
    }
    return re.test(text) ? 'match' : 'no_match';
}

/**
 * The capture groups a match sends to the service as `_meta.captures`
 * (the bot's `matchTrigger`): a regex match's groups, group 1 first,
 * null for an optional group that took no part; [] otherwise.
 */
export function previewCaptures(kind: BehaviorPatternKind, pattern: string, text: string): Array<string | null> {
    if (kind !== 'regex') return [];
    let re: RegExp;
    try {
        re = new RegExp(pattern);
    } catch {
        return [];
    }
    const match = re.exec(text);
    return match ? match.slice(1).map((g) => g ?? null) : [];
}

export const messageTriggerDraftModel: DraftModel<MessageTriggerView, MessageTriggerDraft> = {
    draftOf: draftFromTrigger,
    patchOf: toPatchBody,
};
