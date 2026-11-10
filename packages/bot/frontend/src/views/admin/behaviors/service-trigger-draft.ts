import type { ServiceBehaviorView, ServiceTriggerPatch } from '../../../api/behavior';
import type { DraftModel } from './draft-rebase';
import { draftFromTrigger, toPatchBody, type MessageTriggerDraft } from './message-trigger-draft';

/**
 * A Service Behavior's edit draft (#126): a message trigger draft, of
 * which only the trigger — pattern and audience — is ever sent. Everything
 * else about the row is fixed (the server refuses it): the card does not
 * offer it, and the patch leaves it out.
 */

export const SERVICE_TRIGGER_FIELDS = [
    'patternKind',
    'patternValue',
    'audienceKind',
    'audienceUserId',
    'audienceGroupName',
] as const;

/** The PATCH for the draft's trigger changes; null when it changes none. */
export function serviceTriggerPatch(
    saved: ServiceBehaviorView,
    draft: MessageTriggerDraft,
): ServiceTriggerPatch | null {
    const full = toPatchBody(saved, draft) as Record<string, unknown> | null;
    if (!full) return null;
    const patch: Record<string, unknown> = {};
    for (const key of SERVICE_TRIGGER_FIELDS) if (key in full) patch[key] = full[key];
    if (Object.keys(patch).length === 0) return null;
    return { ...(patch as ServiceTriggerPatch), ifUpdatedAt: saved.updatedAt };
}

export const serviceTriggerDraftModel: DraftModel<ServiceBehaviorView, MessageTriggerDraft> = {
    draftOf: draftFromTrigger,
    patchOf: serviceTriggerPatch,
};
