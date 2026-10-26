import type { MessageTriggerView } from '../../../api/behavior';
import { draftFromTrigger, isDirty, toPatchBody, type MessageTriggerDraft } from './message-trigger-draft';

/**
 * Saved state vs. the edit draft (#105): what a new version of a trigger
 * from the server means for edits in progress, and how "keep my edits"
 * resolves a conflict.
 */

/**
 * A new version of the trigger arrived (a reload, the answer to a toggle).
 * Without edits the draft follows it. With edits the draft is kept: when
 * the new version differs only in what the form does not edit (enabled,
 * stats, order) the edits are rebased onto it; when any form field changed
 * — edited here or not — the draft stays on the old version and
 * `conflict` is set: saving would be refused as stale, so the card asks
 * what to keep (keepEditsOn).
 */
export function rebaseDraft(
    base: MessageTriggerView,
    draft: MessageTriggerDraft,
    incoming: MessageTriggerView,
): { base: MessageTriggerView; draft: MessageTriggerDraft; conflict: boolean } {
    if (!isDirty(base, draft)) return { base: incoming, draft: draftFromTrigger(incoming), conflict: false };
    if (toPatchBody(base, draftFromTrigger(incoming)) === null) return { base: incoming, draft, conflict: false };
    return { base, draft, conflict: true };
}

/**
 * "Keep my edits" after a conflict: the fields edited in `draft` (relative
 * to the version it started from) applied onto the latest version — the
 * rest follows what the other edit saved; where both changed a field,
 * mine wins.
 */
export function keepEditsOn(
    base: MessageTriggerView,
    draft: MessageTriggerDraft,
    latest: MessageTriggerView,
): MessageTriggerDraft {
    const before = draftFromTrigger(base);
    const mine = Object.fromEntries(
        Object.entries(draft).filter(([key, value]) => value !== before[key as keyof MessageTriggerDraft])
    );
    return { ...draftFromTrigger(latest), ...mine };
}

