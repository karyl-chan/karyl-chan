import type {
    BehaviorAudienceKind,
    BehaviorPatch,
    BehaviorPatternKind,
    BehaviorWebhookAuthMode,
    MessageTriggerInput,
    MessageTriggerView,
    ReplyVisibility,
} from '../../../api/behavior';
import type { DraftModel } from './draft-rebase';
import { kindHasGuild, locationKindOf, type LocationKind, type TriggerLocation } from './message-trigger-location';
import { NEW_WEBHOOK, savedWebhookBody, webhookBody, webhookDraftOf, type WebhookDraft } from './webhook-draft';

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

export interface MessageTriggerDraft extends WebhookDraft {
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
        ...webhookDraftOf(t.webhook),
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
        ...NEW_WEBHOOK,
    };
}

/** Move the draft to another kind of location, dropping what does not apply there. */
export function withLocationKind(draft: MessageTriggerDraft, kind: LocationKind): MessageTriggerDraft {
    const next = { ...draft, locationKind: kind };
    if (!kindHasGuild(kind)) next.guildId = '';
    if (kind !== 'channel') next.channelId = '';
    if (kind === 'bot_dm') {
        // the matcher drops bot authors in bot DMs whatever the flag says
        next.ignoreBots = true;
    } else {
        next.audienceKind = 'all';
        next.audienceUserId = '';
        next.audienceGroupName = '';
    }
    return next;
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

/** The trigger fields of a request body (everything but the webhook). */
type TriggerBody = Omit<MessageTriggerInput, 'webhook' | 'enabled'> & {
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

export type MessageTriggerBody = TriggerBody & { webhook: { url: string; authMode: BehaviorWebhookAuthMode | null } };

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
        webhook: webhookBody(d),
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
        webhook: savedWebhookBody(t.webhook),
    };
}

/**
 * The PATCH for saving `draft` over `saved`: only the changed fields, the
 * whole webhook when its URL or authentication changed, and the version
 * the edit is based on. Null when the draft changes nothing.
 */
export function toPatchBody(saved: MessageTriggerView, draft: MessageTriggerDraft): BehaviorPatch | null {
    const before = savedBody(saved);
    const after = toCreateBody(draft);
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(after) as Array<keyof MessageTriggerBody>) {
        if (key === 'webhook') continue;
        if (after[key] !== before[key]) patch[key] = after[key];
    }
    if (after.webhook.url !== before.webhook.url || after.webhook.authMode !== before.webhook.authMode) {
        patch.webhook = after.webhook;
    }
    if (Object.keys(patch).length === 0) return null;
    return { ...(patch as BehaviorPatch), ifUpdatedAt: saved.updatedAt };
}

/**
 * Whether a message would fire the pattern — the same test the bot makes
 * (behavior-trigger.ts `matchesTrigger`); 'invalid' for a regex that does
 * not compile.
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
 * (the bot's `triggerCaptures`): a regex match's groups, group 1 first,
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
