/**
 * The server's rules for a Command, mirrored for the command forms so they
 * can answer while the admin edits (#138): which Behavior Section the
 * command lands in, which visibility combinations Discord refuses, the
 * option rules and the character count Discord limits.
 *
 * Mirrors packages/bot/src/modules/behavior/behavior-section.ts (the
 * command branch) and command-tree-rules.ts. The server stays the
 * authority — it checks every write again — and the bot's
 * tests/behavior-command-rules-mirror.test.ts runs both over every
 * visibility combination, so a change on one side fails until the other
 * follows.
 *
 * Why a mirror and not the server's module: those modules import the
 * models (Sequelize, decorators) and the API error class (Fastify, ajv),
 * which the SPA cannot bundle; and unlike the request schema (served by
 * GET /api/behaviors/schema) a rule is code, not data. Keep this file
 * free of imports: the bot's test compiles it with the server's
 * TypeScript settings.
 */

export type CommandContext = 'Guild' | 'BotDM' | 'PrivateChannel';
export type CommandIntegrationType = 'guild_install' | 'user_install';

export interface CommandVisibility {
    registration: 'global' | 'guild';
    guildId: string | null;
    integrationTypes: readonly CommandIntegrationType[];
    contexts: readonly CommandContext[];
}

export type CommandSection = 'app' | 'bot_dm' | 'guild:all' | `guild:${string}`;

export const MAX_SUBCOMMANDS = 25;
export const MAX_OPTIONS = 25;
export const MAX_COMMAND_CHARS = 8000;

/** Names no behavior command may take: `/login` belongs to the system login. */
export const RESERVED_COMMAND_NAMES: readonly string[] = ['login'];

/** behavior-section.ts `behaviorSection` for a command. */
export function commandSection(v: CommandVisibility): CommandSection {
    if (v.registration === 'guild') {
        return v.guildId !== null ? `guild:${v.guildId}` : 'guild:all';
    }
    const onlyContext =
        v.contexts.length === 1 && !v.integrationTypes.includes('user_install') ? v.contexts[0] : null;
    if (onlyContext === 'BotDM') return 'bot_dm';
    if (onlyContext === 'Guild') return 'guild:all';
    return 'app';
}

export type VisibilityRule =
    | 'guildNeedsGuildId'
    | 'guildContextsOnlyGuild'
    | 'guildInstallOnly'
    | 'globalHasNoGuild'
    | 'privateChannelNeedsUserInstall';

export interface VisibilityIssue {
    field: 'guildId' | 'contexts' | 'integrationTypes';
    rule: VisibilityRule;
}

/** command-tree-rules.ts `checkCommandSettings`, in the server's order (it refuses the first). */
export function visibilityIssues(v: CommandVisibility): VisibilityIssue[] {
    const issues: VisibilityIssue[] = [];
    if (v.registration === 'guild') {
        if (v.guildId === null) issues.push({ field: 'guildId', rule: 'guildNeedsGuildId' });
        if (v.contexts.length !== 1 || v.contexts[0] !== 'Guild') {
            issues.push({ field: 'contexts', rule: 'guildContextsOnlyGuild' });
        }
        if (v.integrationTypes.length !== 1 || v.integrationTypes[0] !== 'guild_install') {
            issues.push({ field: 'integrationTypes', rule: 'guildInstallOnly' });
        }
    } else if (v.guildId !== null) {
        issues.push({ field: 'guildId', rule: 'globalHasNoGuild' });
    } else if (v.contexts.includes('PrivateChannel') && !v.integrationTypes.includes('user_install')) {
        issues.push({ field: 'contexts', rule: 'privateChannelNeedsUserInstall' });
    }
    return issues;
}

export interface OptionShape {
    name: string;
    description: string;
    required: boolean;
}

export interface OptionIssue {
    /** The option at fault; null for the list as a whole. */
    index: number | null;
    field: 'name' | 'required' | null;
    rule: 'tooMany' | 'duplicateName' | 'requiredAfterOptional';
}

/** command-tree-rules.ts `checkLeafOptions`, in the server's order. */
export function optionIssues(options: readonly OptionShape[]): OptionIssue[] {
    const issues: OptionIssue[] = [];
    if (options.length > MAX_OPTIONS) issues.push({ index: null, field: null, rule: 'tooMany' });
    const seen = new Set<string>();
    let sawOptional = false;
    options.forEach((option, index) => {
        if (seen.has(option.name)) issues.push({ index, field: 'name', rule: 'duplicateName' });
        seen.add(option.name);
        if (option.required && sawOptional) issues.push({ index, field: 'required', rule: 'requiredAfterOptional' });
        if (!option.required) sawOptional = true;
    });
    return issues;
}

export interface LeafShape {
    subcommand: string;
    title: string;
    leafDescription: string | null;
    options: readonly Pick<OptionShape, 'name' | 'description'>[];
}

/** command-tree-rules.ts `commandCharCount`: what Discord counts toward its 8000 limit. */
export function commandCharCount(
    command: { name: string; description: string },
    leaves: readonly LeafShape[],
): number {
    let total = command.name.length + command.description.length;
    for (const leaf of leaves) {
        if (leaf.subcommand !== '') {
            total += leaf.subcommand.length + (leaf.leafDescription || leaf.title).length;
        }
        for (const option of leaf.options) total += option.name.length + option.description.length;
    }
    return total;
}
