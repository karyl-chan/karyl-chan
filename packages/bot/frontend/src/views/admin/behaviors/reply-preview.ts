import type { BehaviorReplyView, ReplyVisibility } from '../../../api/behavior';

/**
 * Where a behavior's reply goes — the trigger's kind as the bot's
 * ReplyRenderer sees it: a command, a message in a DM with the bot, or a
 * message in a guild channel.
 */
export type ReplyTargetKind = 'command' | 'bot_dm' | 'guild';

/**
 * Who would see a reply (the `ephemeral` rules of the reply model, #140):
 * only the invoker, everyone in the channel, the DM with the bot, or the
 * author's DMs instead of the channel.
 */
export type ReplyAudience = 'invoker' | 'channel' | 'dm' | 'author_dm';

export interface ReplyPreview {
    content: string | null;
    embedTitles: Array<string | null>;
    buttons: Array<{ label: string; url: string }>;
    audience: ReplyAudience;
    empty: boolean;
}

export function replyAudience(ephemeral: boolean | undefined, target: ReplyTargetKind): ReplyAudience {
    if (target === 'bot_dm') return 'dm';
    if (target === 'command') return ephemeral === false ? 'channel' : 'invoker';
    return ephemeral === true ? 'author_dm' : 'channel';
}

/**
 * A test-fire's reply as the bot would render it, summarised for the admin.
 * Who sees it: the response's `ephemeral`, else the stored default, else
 * the trigger's own default (the bot's renderer, in the same order).
 */
export function replyPreview(
    reply: BehaviorReplyView,
    target: ReplyTargetKind,
    stored: ReplyVisibility | null = null
): ReplyPreview {
    const embedTitles = (reply.embeds ?? []).map((e) => e.title ?? null);
    const buttons = (reply.components ?? []).flatMap((row) => row.components.map((b) => ({ label: b.label, url: b.url })));
    const content = reply.content ?? null;
    return {
        content,
        embedTitles,
        buttons,
        audience: replyAudience(reply.ephemeral ?? (stored ? stored === 'private' : undefined), target),
        empty: content === null && embedTitles.length === 0 && buttons.length === 0,
    };
}
