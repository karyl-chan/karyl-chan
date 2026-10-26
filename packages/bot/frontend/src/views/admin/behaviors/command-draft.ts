import type { BehaviorSection, CommandInput, CommandPatch, CommandView } from '../../../api/behavior';
import { parseSection } from './behavior-sections';
import {
    commandSection,
    type CommandContext,
    type CommandIntegrationType,
    type CommandSection,
    type CommandVisibility,
} from './command-rules';
import type { DraftModel } from './draft-rebase';

/**
 * The edit draft of a Command (board 5): its name, its description and
 * its visibility — registration target, installs, contexts, default
 * member permissions. Leaves have their own drafts (leaf-draft.ts).
 *
 * The draft holds what the form shows (ids as text, '' = empty); the
 * request body is derived from it, so a server command always sends the
 * contexts and installs Discord allows a server command (withRegistration).
 */
export interface CommandDraft {
    name: string;
    description: string;
    registration: 'global' | 'guild';
    guildId: string;
    integrationTypes: CommandIntegrationType[];
    contexts: CommandContext[];
    /** A permission bit set as text; '' = everyone. */
    defaultMemberPermissions: string;
}

export function draftFromCommand(c: CommandView): CommandDraft {
    return {
        name: c.name,
        description: c.description,
        registration: c.registration,
        guildId: c.guildId ?? '',
        integrationTypes: [...c.integrationTypes],
        contexts: [...c.contexts],
        defaultMemberPermissions: c.defaultMemberPermissions ?? '',
    };
}

/** A server command is used in its server and installed by it — nothing else (Discord's rule). */
export function withRegistration(d: CommandDraft, registration: 'global' | 'guild'): CommandDraft {
    if (registration === 'guild') {
        return { ...d, registration, contexts: ['Guild'], integrationTypes: ['guild_install'] };
    }
    return { ...d, registration, guildId: '' };
}

export function visibilityOf(d: Pick<CommandDraft, 'registration' | 'guildId' | 'integrationTypes' | 'contexts'>): CommandVisibility {
    return {
        registration: d.registration,
        guildId: d.registration === 'guild' && d.guildId.trim() ? d.guildId.trim() : null,
        integrationTypes: d.integrationTypes,
        contexts: d.contexts,
    };
}

/** Where saving the draft puts the command; null while a server command has no server yet. */
export function draftSection(d: CommandDraft): CommandSection | null {
    if (d.registration === 'guild' && !d.guildId.trim()) return null;
    return commandSection(visibilityOf(d));
}

const sorted = <T extends string>(items: readonly T[]): T[] => [...items].sort();

/** The command fields of a request body. */
export function commandBody(d: CommandDraft): Required<CommandInput> {
    return {
        name: d.name.trim(),
        description: d.description.trim(),
        registration: d.registration,
        // an empty id stays '' (not null): the schema then names the field
        guildId: d.registration === 'guild' ? d.guildId.trim() : null,
        integrationTypes: sorted(d.integrationTypes),
        contexts: sorted(d.contexts),
        defaultMemberPermissions: d.defaultMemberPermissions.trim() || null,
    };
}

function savedBody(c: CommandView): Required<CommandInput> {
    return {
        name: c.name,
        description: c.description,
        registration: c.registration,
        guildId: c.guildId,
        integrationTypes: sorted(c.integrationTypes),
        contexts: sorted(c.contexts),
        defaultMemberPermissions: c.defaultMemberPermissions,
    };
}

/**
 * The PATCH for saving `draft` over `saved`: only the changed fields and
 * the version the edit is based on. Null when the draft changes nothing.
 */
export function commandPatch(saved: CommandView, draft: CommandDraft): CommandPatch | null {
    const before = savedBody(saved);
    const after = commandBody(draft);
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(after) as Array<keyof CommandInput>) {
        if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) patch[key] = after[key];
    }
    if (Object.keys(patch).length === 0) return null;
    return { ...(patch as CommandPatch), ifUpdatedAt: saved.updatedAt };
}

export const commandDraftModel: DraftModel<CommandView, CommandDraft> = {
    draftOf: draftFromCommand,
    patchOf: commandPatch,
};

export type NewCommandVisibility = Pick<CommandDraft, 'registration' | 'guildId' | 'integrationTypes' | 'contexts'>;

/**
 * The visibility a command created in a section starts with — one that
 * keeps it in that section (board 2); the card changes it afterwards.
 * Null where no command can live (one channel).
 */
export function newCommandVisibility(section: BehaviorSection): NewCommandVisibility | null {
    const s = parseSection(section);
    const global = (integrationTypes: CommandIntegrationType[], contexts: CommandContext[]): NewCommandVisibility => ({
        registration: 'global',
        guildId: '',
        integrationTypes,
        contexts,
    });
    switch (s.kind) {
        case 'app':
            return global(['guild_install', 'user_install'], ['Guild', 'BotDM', 'PrivateChannel']);
        case 'bot_dm':
            return global(['guild_install'], ['BotDM']);
        case 'guild_all':
            return global(['guild_install'], ['Guild']);
        case 'guild':
            return { registration: 'guild', guildId: s.guildId, integrationTypes: ['guild_install'], contexts: ['Guild'] };
        case 'channel':
            return null;
    }
}
