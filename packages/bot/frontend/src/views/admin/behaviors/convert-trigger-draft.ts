import type {
    CommandLeafView,
    CommandView,
    ConvertToCommandInput,
    ConvertToMessageInput,
    MessageTriggerView,
} from '../../../api/behavior';
import { parseSection } from './behavior-sections';
import { commandBody, newCommandVisibility, type CommandDraft } from './command-draft';
import { draftLocation, emptyDraft, toCreateBody, type MessageTriggerDraft } from './message-trigger-draft';
import { locationKey, type LocationKind } from './message-trigger-location';

/**
 * Converting a custom behavior between a Message Trigger and a Command
 * Leaf (#172, POST /api/behaviors/:id/convert-trigger): what the two
 * dialogs start from, the request they send, and — before the admin
 * confirms — what the behavior loses or changes on the way. The behavior
 * itself stays (id, webhook, secret, stats, deliveries); these are only
 * about its trigger.
 */

// ── message → command ───────────────────────────────────────────────────────

/** A title as a Discord command name: lower case, `a-z0-9_-`, ≤32; '' when nothing is left (a CJK title). */
export function commandNameOf(title: string): string {
    return title
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 32);
}

/**
 * The visibility a command made from this trigger starts with — the one a
 * new command gets in its section (newCommandVisibility); a channel's
 * trigger becomes a command of the channel's server, as Discord cannot
 * limit a command to one channel.
 */
export function convertedCommandDraft(trigger: MessageTriggerView): CommandDraft {
    const s = parseSection(trigger.section);
    const visibility =
        newCommandVisibility(s.kind === 'channel' ? `guild:${s.guildId}` : trigger.section) ?? newCommandVisibility('app')!;
    return {
        ...visibility,
        name: commandNameOf(trigger.title),
        description: trigger.title,
        defaultMemberPermissions: '',
    };
}

/** The commands a trigger can join as a subcommand: those that already have subcommands. */
export function commandsWithSubcommands(commands: readonly CommandView[]): CommandView[] {
    return commands.filter((c) => !c.isSystem && c.leaves.length > 0 && c.leaves.every((l) => l.subcommand !== ''));
}

/** Commands with only a root leaf: they must convert-to-subcommands before another leaf can join. */
export function singleCommands(commands: readonly CommandView[]): CommandView[] {
    return commands.filter((c) => !c.isSystem && c.leaves.length === 1 && c.leaves[0].subcommand === '');
}

export type ToCommandTarget =
    | { kind: 'new'; command: CommandDraft }
    | { kind: 'existing'; commandId: number | null; subcommandName: string };

export function toCommandBody(target: ToCommandTarget): ConvertToCommandInput {
    if (target.kind === 'new') {
        const { defaultMemberPermissions, ...command } = commandBody(target.command);
        return { command: { new: { ...command, ...(defaultMemberPermissions ? { defaultMemberPermissions } : {}) } } };
    }
    return { command: { existingId: target.commandId ?? 0, subcommandName: target.subcommandName.trim() } };
}

/** One line of what a conversion loses or changes: an i18n key and its values. */
export interface ConvertLoss {
    key: string;
    values?: Record<string, string | number>;
}

/** What a message trigger loses or changes as a command leaf. */
export function toCommandLosses(trigger: MessageTriggerView): ConvertLoss[] {
    const losses: ConvertLoss[] = [];
    if (trigger.channelId) losses.push({ key: 'behaviors.convertTrigger.loss.channel' });
    if (trigger.surface === 'bot_dm' && trigger.audienceKind !== 'all') {
        losses.push({ key: 'behaviors.convertTrigger.loss.audience' });
    }
    losses.push({ key: 'behaviors.convertTrigger.loss.pattern', values: { pattern: trigger.patternValue } });
    if (trigger.surface === 'guild' && trigger.replyVisibility === null) {
        losses.push({ key: 'behaviors.convertTrigger.loss.replyPrivate' });
    }
    losses.push({ key: 'behaviors.convertTrigger.loss.payloadToCommand' });
    return losses;
}

// ── command → message ───────────────────────────────────────────────────────

/** Where a message trigger made from a command starts: the command's own section, where it can hold one. */
export function convertedMessageDraft(command: CommandView): MessageTriggerDraft {
    const s = parseSection(command.section);
    return s.kind === 'guild'
        ? emptyDraft({ kind: 'guild', guildId: s.guildId })
        : emptyDraft({ kind: s.kind === 'guild_all' ? 'guild_all' : 'bot_dm' });
}

/** Every location a converted trigger may go to: any, whatever section the command was in. */
export const CONVERT_LOCATION_KINDS: readonly LocationKind[] = ['bot_dm', 'guild_all', 'guild', 'channel'];

/** The request for the draft; null while the location still lacks an id it needs. */
export function toMessageBody(draft: MessageTriggerDraft): ConvertToMessageInput | null {
    const location = draftLocation(draft);
    if (!location) return null;
    const body = toCreateBody(draft);
    const inDm = location.kind === 'bot_dm';
    return {
        location: locationKey(location),
        patternKind: body.patternKind,
        patternValue: body.patternValue,
        stopOnMatch: body.stopOnMatch,
        ...(inDm
            ? {
                  audienceKind: body.audienceKind,
                  audienceUserId: body.audienceUserId,
                  audienceGroupName: body.audienceGroupName,
              }
            : { ignoreBots: body.ignoreBots }),
    };
}

/** What a command leaf loses or changes as a message trigger at the draft's location. */
export function toMessageLosses(command: CommandView, leaf: CommandLeafView, draft: MessageTriggerDraft): ConvertLoss[] {
    const losses: ConvertLoss[] = [];
    if (leaf.options.length > 0) {
        losses.push({ key: 'behaviors.convertTrigger.loss.options', values: { count: leaf.options.length } });
    }
    if (draft.locationKind !== 'bot_dm' && leaf.replyVisibility !== 'public') {
        losses.push({
            key:
                leaf.replyVisibility === 'private'
                    ? 'behaviors.convertTrigger.loss.replyDm'
                    : 'behaviors.convertTrigger.loss.replyPublic',
        });
    }
    losses.push({ key: 'behaviors.convertTrigger.loss.payloadToMessage' });
    losses.push(
        command.leaves.length === 1
            ? { key: 'behaviors.convertTrigger.loss.commandRemoved', values: { command: command.name } }
            : {
                  key: 'behaviors.convertTrigger.loss.subcommandRemoved',
                  values: { command: command.name, subcommand: leaf.subcommand },
              }
    );
    return losses;
}
