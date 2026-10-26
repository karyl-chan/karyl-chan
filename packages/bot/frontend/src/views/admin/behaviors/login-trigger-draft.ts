import type {
    BehaviorItemView,
    BehaviorSection,
    LoginPatternKind,
    LoginTriggerInput,
} from '../../../api/behavior';
import { errorsFromIssues, type FormErrors } from './behavior-errors';
import {
    commandSection,
    visibilityIssues,
    type CommandContext,
    type CommandIntegrationType,
    type CommandVisibility,
} from './command-rules';
import type { CommandDraft } from './command-draft';
import type { DraftModel } from './draft-rebase';
import { checkAgainstSchema, type JsonSchema } from './form-schema';
import { previewMatch } from './message-trigger-draft';
import type { Translate } from './translate';

/**
 * The edit draft of the System Behavior's trigger (boards 3 and 4): the
 * login is a bot DM message pattern or a global command, and the form
 * keeps both halves so flipping the kind back and forth loses nothing.
 * Only the chosen half is sent (PUT /api/behaviors/system/login/trigger).
 *
 * A message pattern is `startswith` or `endswith` (no regex), and every
 * message save carries a `sample`: a DM the admin would send, which the
 * server checks the pattern against — so a slip cannot lock the owner
 * out. The sample is not stored and editing it alone is not a change.
 *
 * A command is always global with no default member permissions — the
 * server fixes those (system-login-trigger.ts) — and always keeps
 * `guild_install` and `BotDM`, so the owner can reach it; the draft has
 * its name, description, installs and contexts.
 */
export interface LoginTriggerDraft {
    kind: 'message' | 'command';
    patternKind: LoginPatternKind;
    patternValue: string;
    sample: string;
    name: string;
    description: string;
    integrationTypes: CommandIntegrationType[];
    contexts: CommandContext[];
}

export const LOGIN_PATTERN_KINDS: readonly LoginPatternKind[] = ['startswith', 'endswith'];

/** What the login command always keeps (the server refuses it without them). */
export const LOGIN_COMMAND_REQUIRED = {
    integrationTypes: ['guild_install'] as CommandIntegrationType[],
    contexts: ['BotDM'] as CommandContext[],
};

/**
 * What the form offers on the side the login is not on. Suggestions, not
 * a rule mirror: the form always sends every field, so the server's own
 * defaults (system-login-trigger.ts) never apply to it, and the server
 * checks whatever is sent. The command description is the one the system
 * login command has always had (the pre-ADR 0003 seed, which migration
 * 011 copies).
 */
export const DEFAULT_LOGIN_MESSAGE = { patternKind: 'startswith', patternValue: '!login' } as const;
export const DEFAULT_LOGIN_COMMAND = {
    name: 'login',
    description: '取得 admin 後台一次性登入連結(僅授權使用者)',
    integrationTypes: LOGIN_COMMAND_REQUIRED.integrationTypes,
    contexts: LOGIN_COMMAND_REQUIRED.contexts,
};

export function loginTriggerDraftOf(view: BehaviorItemView): LoginTriggerDraft {
    if (view.kind === 'command') {
        return {
            kind: 'command',
            ...DEFAULT_LOGIN_MESSAGE,
            sample: '',
            name: view.name,
            description: view.description,
            integrationTypes: [...view.integrationTypes],
            contexts: [...view.contexts],
        };
    }
    return {
        kind: 'message',
        // a stored regex (from before the switch existed) shows as startswith: the admin picks again
        patternKind: view.patternKind === 'endswith' ? 'endswith' : 'startswith',
        patternValue: view.patternValue,
        sample: '',
        ...DEFAULT_LOGIN_COMMAND,
        integrationTypes: [...DEFAULT_LOGIN_COMMAND.integrationTypes],
        contexts: [...DEFAULT_LOGIN_COMMAND.contexts],
    };
}

/** The visibility of the login command: always global, never one server. */
export function globalVisibilityOf(d: Pick<LoginTriggerDraft, 'integrationTypes' | 'contexts'>): CommandVisibility {
    return { registration: 'global', guildId: null, integrationTypes: d.integrationTypes, contexts: d.contexts };
}

/** The command half as CommandVisibilityFields edits it (a form draft: '' = no server). */
export function loginCommandDraftOf(d: LoginTriggerDraft): CommandDraft {
    return {
        name: d.name,
        description: d.description,
        registration: 'global',
        guildId: '',
        integrationTypes: d.integrationTypes,
        contexts: d.contexts,
        defaultMemberPermissions: '',
    };
}

const sorted = <T extends string>(items: readonly T[]): T[] => [...items].sort();

/** The trigger the draft's chosen half describes (no sample: that is not part of the trigger). */
function triggerOf(d: LoginTriggerDraft): Record<string, unknown> {
    return d.kind === 'message'
        ? { kind: 'message', patternKind: d.patternKind, patternValue: d.patternValue }
        : {
              kind: 'command',
              name: d.name.trim(),
              description: d.description.trim(),
              integrationTypes: sorted(d.integrationTypes),
              contexts: sorted(d.contexts),
          };
}

/** The request body for the draft's chosen half; a message carries its sample. */
export function loginTriggerBody(d: LoginTriggerDraft): LoginTriggerInput {
    return d.kind === 'message'
        ? { kind: 'message', patternKind: d.patternKind, patternValue: d.patternValue, sample: d.sample }
        : (triggerOf(d) as LoginTriggerInput);
}

/** The PUT for saving `draft` over `saved`; null when the trigger does not change. */
export function loginTriggerPatch(
    saved: BehaviorItemView,
    draft: LoginTriggerDraft,
): (LoginTriggerInput & { ifUpdatedAt: string }) | null {
    if (JSON.stringify(triggerOf(draft)) === JSON.stringify(triggerOf(loginTriggerDraftOf(saved)))) return null;
    return { ...loginTriggerBody(draft), ifUpdatedAt: saved.updatedAt };
}

/** Whether saving moves the login from a message to a command or back (board 4's confirm). */
export function switchesKind(saved: BehaviorItemView, draft: LoginTriggerDraft): boolean {
    return saved.kind !== draft.kind;
}

/** The trigger as a user sends it: the pattern, or `/name`. */
export function loginTriggerText(t: Pick<LoginTriggerDraft, 'kind' | 'patternValue' | 'name'>): string {
    return t.kind === 'command' ? `/${t.name.trim()}` : t.patternValue;
}

/** Where the login lands once saved: bot DMs for a message, its visibility's section for a command. */
export function loginDraftSection(d: LoginTriggerDraft): BehaviorSection {
    return d.kind === 'message' ? 'bot_dm' : commandSection(globalVisibilityOf(d));
}

export const loginTriggerDraftModel: DraftModel<BehaviorItemView, LoginTriggerDraft> = {
    draftOf: loginTriggerDraftOf,
    patchOf: loginTriggerPatch,
};

/** The fields the form shows an error line on, for the chosen half. */
export function loginTriggerFields(d: Pick<LoginTriggerDraft, 'kind'>): string[] {
    return d.kind === 'message'
        ? ['patternKind', 'patternValue', 'sample']
        : ['name', 'description', 'integrationTypes', 'contexts'];
}

/**
 * What the server would refuse in the draft, while the admin types: the
 * body against the served schema (null = not loaded); for a message, a
 * missing sample or one the pattern does not match (previewMatch is the
 * matcher's rule, run on the sample as Discord delivers it — trimmed);
 * for a command, Discord's visibility rules (command-rules.ts, pinned to
 * the server's) and the two settings the login command always keeps. The
 * server checks all of it again; the other pattern rules (no edge spaces)
 * are its alone — its refusal lands on the field.
 */
export function loginTriggerDraftErrors(t: Translate, d: LoginTriggerDraft, schema: JsonSchema | null): FormErrors {
    const found: FormErrors = schema
        ? errorsFromIssues(t, checkAgainstSchema(schema, loginTriggerBody(d)), loginTriggerFields(d))
        : { fields: {}, general: null };
    if (d.kind === 'message') {
        if (d.sample.trim() === '') found.fields.sample = t('behaviors.system.sampleRequired');
        else if (d.patternValue !== '' && previewMatch(d.patternKind, d.patternValue, d.sample.trim()) !== 'match') {
            found.fields.sample = t('behaviors.system.sampleNoMatch');
        }
        return found;
    }
    for (const issue of visibilityIssues(globalVisibilityOf(d))) {
        found.fields[issue.field] ??= t(`behaviors.command.rule.${issue.rule}`);
    }
    if (!LOGIN_COMMAND_REQUIRED.integrationTypes.every((i) => d.integrationTypes.includes(i))) {
        found.fields.integrationTypes ??= t('behaviors.system.rule.needsGuildInstall');
    }
    if (!LOGIN_COMMAND_REQUIRED.contexts.every((c) => d.contexts.includes(c))) {
        found.fields.contexts ??= t('behaviors.system.rule.needsBotDm');
    }
    return found;
}
