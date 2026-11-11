import type {
    BehaviorSection,
    MessageTriggerView,
    ServiceBehaviorView,
    ServiceTriggerInput,
} from '../../../api/behavior';
import type { FormErrors } from './behavior-errors';
import type { CommandDraft } from './command-draft';
import {
    commandSection,
    visibilityIssues,
    type CommandContext,
    type CommandIntegrationType,
    type CommandVisibility,
} from './command-rules';
import type { DraftModel } from './draft-rebase';
import { draftFromTrigger, emptyDraft, previewMatch, type MessageTriggerDraft } from './message-trigger-draft';
import type { Translate } from './translate';

/**
 * A Service Behavior's trigger draft (#126): like the login's, a bot DM
 * pattern or a global command — the card edits the half it is on, and
 * the kind tag turns it to the other. Unlike the login's, the pattern may
 * be a regex and has an audience (who may log in to the service), and the
 * command has no install or context it must keep. Only the chosen half is
 * sent (PUT /api/services/:id/trigger).
 *
 * The message half is a message trigger draft, so the one trigger editor
 * (MessageTriggerFields) edits it; its location and stop flag are fixed.
 */
export interface ServiceTriggerDraft extends MessageTriggerDraft {
    kind: 'message' | 'command';
    name: string;
    commandDescription: string;
    integrationTypes: CommandIntegrationType[];
    contexts: CommandContext[];
}

/** What a command offers on first switch: DMs with the bot, named after the audience. */
function defaultCommand(view: ServiceBehaviorView) {
    return {
        name: `${view.service.audience}-login`.slice(0, 32),
        commandDescription: `登入 ${view.service.name}`.slice(0, 100),
        integrationTypes: ['guild_install'] as CommandIntegrationType[],
        contexts: ['BotDM'] as CommandContext[],
    };
}

/** What a pattern offers when switching back from a command: the default `!login-<audience>`. */
function defaultMessage(view: ServiceBehaviorView): MessageTriggerDraft {
    return { ...emptyDraft({ kind: 'bot_dm' }), patternKind: 'regex', patternValue: `^!login-${view.service.audience}$` };
}

export function serviceTriggerDraftOf(view: ServiceBehaviorView): ServiceTriggerDraft {
    if (view.kind === 'command') {
        return {
            ...defaultMessage(view),
            kind: 'command',
            name: view.name,
            commandDescription: view.description,
            integrationTypes: [...view.integrationTypes],
            contexts: [...view.contexts],
        };
    }
    return { ...draftFromTrigger(view as MessageTriggerView), kind: 'message', ...defaultCommand(view) };
}

const sorted = <T extends string>(items: readonly T[]): T[] => [...items].sort();

/** The request body for the draft's chosen half. */
export function serviceTriggerBody(d: ServiceTriggerDraft): ServiceTriggerInput {
    if (d.kind === 'command') {
        return {
            kind: 'command',
            name: d.name.trim(),
            description: d.commandDescription.trim(),
            integrationTypes: sorted(d.integrationTypes),
            contexts: sorted(d.contexts),
        };
    }
    return {
        kind: 'message',
        patternKind: d.patternKind,
        patternValue: d.patternValue,
        audienceKind: d.audienceKind,
        audienceUserId: d.audienceKind === 'user' ? d.audienceUserId.trim() : null,
        audienceGroupName: d.audienceKind === 'group' ? d.audienceGroupName.trim() : null,
    };
}

/** The PUT for saving `draft` over `saved`; null when the trigger does not change. */
export function serviceTriggerPatch(
    saved: ServiceBehaviorView,
    draft: ServiceTriggerDraft,
): (ServiceTriggerInput & { ifUpdatedAt: string }) | null {
    const body = serviceTriggerBody(draft);
    if (JSON.stringify(body) === JSON.stringify(serviceTriggerBody(serviceTriggerDraftOf(saved)))) return null;
    return { ...body, ifUpdatedAt: saved.updatedAt };
}

export const serviceTriggerDraftModel: DraftModel<ServiceBehaviorView, ServiceTriggerDraft> = {
    draftOf: serviceTriggerDraftOf,
    patchOf: serviceTriggerPatch,
};

/** The command half as CommandVisibilityFields edits it: always global, everyone. */
export function serviceCommandDraftOf(d: ServiceTriggerDraft): CommandDraft {
    return {
        name: d.name,
        description: d.commandDescription,
        registration: 'global',
        guildId: '',
        integrationTypes: d.integrationTypes,
        contexts: d.contexts,
        defaultMemberPermissions: '',
    };
}

function visibilityOf(d: ServiceTriggerDraft): CommandVisibility {
    return { registration: 'global', guildId: null, integrationTypes: d.integrationTypes, contexts: d.contexts };
}

/** Where the trigger lands once saved: bot DMs for a pattern, its visibility's section for a command. */
export function serviceDraftSection(d: ServiceTriggerDraft): BehaviorSection {
    return d.kind === 'message' ? 'bot_dm' : commandSection(visibilityOf(d));
}

/** The fields the form shows an error line on, for the chosen half (server field names). */
export function serviceTriggerFields(d: Pick<ServiceTriggerDraft, 'kind'>): string[] {
    return d.kind === 'message'
        ? ['patternKind', 'patternValue', 'audienceKind', 'audienceUserId', 'audienceGroupName']
        : ['name', 'description', 'integrationTypes', 'contexts'];
}

/** What the server would refuse, found before sending (it checks again). */
export function serviceTriggerDraftErrors(t: Translate, d: ServiceTriggerDraft): FormErrors {
    const found: FormErrors = { fields: {}, general: null };
    if (d.kind === 'message') {
        if (d.patternValue === '') found.fields.patternValue = t('behaviors.service.patternRequired');
        else if (d.patternKind === 'regex' && previewMatch('regex', d.patternValue, '') === 'invalid') {
            found.fields.patternValue = t('behaviors.trigger.preview.invalid');
        }
        return found;
    }
    if (!/^[a-z0-9_-]{1,32}$/.test(d.name.trim())) found.fields.name = t('behaviors.service.commandName');
    if (d.commandDescription.trim() === '') found.fields.description = t('behaviors.service.descriptionRequired');
    for (const issue of visibilityIssues(visibilityOf(d))) {
        found.fields[issue.field] ??= t(`behaviors.command.rule.${issue.rule}`);
    }
    return found;
}
