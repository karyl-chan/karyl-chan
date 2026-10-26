import type { BehaviorWebhookAuthMode, WebhookActionView } from '../../../api/behavior';

/**
 * The webhook action half of a behavior draft — the same in every form
 * that edits a webhook (a message trigger, a command leaf). The draft
 * holds what WebhookActionFields shows; `webhookBody` is what a request
 * sends.
 */

export type AuthChoice = 'none' | BehaviorWebhookAuthMode;

export interface WebhookDraft {
    webhookUrl: string;
    authMode: AuthChoice;
}

export function webhookDraftOf(webhook: WebhookActionView | null): WebhookDraft {
    return { webhookUrl: webhook?.url ?? '', authMode: webhook?.authMode ?? 'none' };
}

/** A new webhook: authenticated with HMAC unless the admin turns it off. */
export const NEW_WEBHOOK: WebhookDraft = { webhookUrl: '', authMode: 'hmac' };

export function webhookBody(d: WebhookDraft): { url: string; authMode: BehaviorWebhookAuthMode | null } {
    return { url: d.webhookUrl.trim(), authMode: d.authMode === 'none' ? null : d.authMode };
}

/** The saved webhook in request form, to compare a draft against. */
export function savedWebhookBody(webhook: WebhookActionView | null): { url: string; authMode: BehaviorWebhookAuthMode | null } {
    return { url: webhook?.url ?? '', authMode: webhook?.authMode ?? null };
}
