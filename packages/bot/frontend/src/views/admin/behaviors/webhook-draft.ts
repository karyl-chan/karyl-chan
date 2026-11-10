import type {
    BehaviorActionSource,
    BehaviorWebhookAuthMode,
    PluginActionView,
    WebhookActionView,
} from '../../../api/behavior';

/**
 * The action half of a behavior draft — the same in every form that edits
 * an action (a message trigger, a command leaf): a webhook, or a plugin
 * action (#203). The draft holds what WebhookActionFields shows, both
 * kinds at once, so switching back and forth keeps what was typed;
 * `actionBody` is what a request sends — only the chosen kind.
 */

export type AuthChoice = 'none' | BehaviorWebhookAuthMode;

/** The action sources an admin can choose (builtin is the system login's alone). */
export type ActionSourceChoice = 'webhook' | 'plugin';

export interface WebhookDraft {
    webhookUrl: string;
    authMode: AuthChoice;
}

export interface ActionDraft extends WebhookDraft {
    actionSource: ActionSourceChoice;
    /** The plugin action picked; '' while none is. */
    pluginKey: string;
    actionKey: string;
}

export function webhookDraftOf(webhook: WebhookActionView | null): WebhookDraft {
    return { webhookUrl: webhook?.url ?? '', authMode: webhook?.authMode ?? 'none' };
}

/** A new webhook: authenticated with HMAC unless the admin turns it off. */
export const NEW_WEBHOOK: WebhookDraft = { webhookUrl: '', authMode: 'hmac' };

/** A new action: a webhook (as before plugin actions), nothing picked on the plugin side. */
export const NEW_ACTION: ActionDraft = { ...NEW_WEBHOOK, actionSource: 'webhook', pluginKey: '', actionKey: '' };

interface SavedAction {
    actionSource: BehaviorActionSource;
    webhook: WebhookActionView | null;
    pluginAction: PluginActionView | null;
}

/** The draft of a saved behavior's action. A plugin action's webhook side starts as a new webhook. */
export function actionDraftOf(saved: SavedAction): ActionDraft {
    return saved.actionSource === 'plugin'
        ? {
              ...NEW_WEBHOOK,
              actionSource: 'plugin',
              pluginKey: saved.pluginAction?.pluginKey ?? '',
              actionKey: saved.pluginAction?.actionKey ?? '',
          }
        : { ...webhookDraftOf(saved.webhook), actionSource: 'webhook', pluginKey: '', actionKey: '' };
}

export interface WebhookBody {
    url: string;
    authMode: BehaviorWebhookAuthMode | null;
}

/** The action of a request body: `webhook` or `pluginAction`, never both. */
export type ActionBody = { webhook: WebhookBody; pluginAction?: never } | { pluginAction: PluginActionView; webhook?: never };

export function webhookBody(d: WebhookDraft): WebhookBody {
    return { url: d.webhookUrl.trim(), authMode: d.authMode === 'none' ? null : d.authMode };
}

/** The saved webhook in request form, to compare a draft against. */
export function savedWebhookBody(webhook: WebhookActionView | null): WebhookBody {
    return { url: webhook?.url ?? '', authMode: webhook?.authMode ?? null };
}

export function actionBody(d: ActionDraft): ActionBody {
    return d.actionSource === 'plugin'
        ? { pluginAction: { pluginKey: d.pluginKey, actionKey: d.actionKey } }
        : { webhook: webhookBody(d) };
}

/** The saved action in request form, to compare a draft against. */
export function savedActionBody(saved: SavedAction): ActionBody {
    return saved.actionSource === 'plugin'
        ? { pluginAction: { pluginKey: saved.pluginAction?.pluginKey ?? '', actionKey: saved.pluginAction?.actionKey ?? '' } }
        : { webhook: savedWebhookBody(saved.webhook) };
}

/** The action of a whole request body: its `webhook` or its `pluginAction`. */
export function actionPartOf(body: ActionBody): ActionBody {
    return body.webhook ? { webhook: body.webhook } : { pluginAction: body.pluginAction! };
}

/** Whether two actions in request form differ (a change of source included). */
export function actionChanged(a: ActionBody, b: ActionBody): boolean {
    return JSON.stringify(a) !== JSON.stringify(b);
}

/** The action fields a form shows an error line on (the server's `error.field` paths). */
export const ACTION_ERROR_FIELDS = [
    'webhook.url',
    'webhook.authMode',
    'pluginAction',
    'pluginAction.pluginKey',
    'pluginAction.actionKey',
] as const;
