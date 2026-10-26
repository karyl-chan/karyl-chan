/**
 * Saved state vs. the edit draft (#105): what a new version of a saved
 * row from the server means for edits in progress, and how "keep my
 * edits" resolves a conflict. The same rules hold for every behavior form
 * (a message trigger, a command, a command leaf); each supplies its
 * DraftModel.
 */

/** How a form turns a saved row into a draft, and a draft into its PATCH. */
export interface DraftModel<V, D extends object> {
    draftOf(saved: V): D;
    /** The PATCH saving `draft` over `saved` would send; null when it changes nothing. */
    patchOf(saved: V, draft: D): object | null;
}

function same(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A new version of the row arrived (a reload, the answer to a toggle).
 * Without edits the draft follows it. With edits the draft is kept: when
 * the new version differs only in what the form does not edit (enabled,
 * stats, order) the edits are rebased onto it; when any form field changed
 * — edited here or not — the draft stays on the old version and
 * `conflict` is set: saving would be refused as stale, so the form asks
 * what to keep (keepEditsOnWith).
 */
export function rebaseDraftWith<V, D extends object>(
    model: DraftModel<V, D>,
    base: V,
    draft: D,
    incoming: V,
): { base: V; draft: D; conflict: boolean } {
    if (model.patchOf(base, draft) === null) return { base: incoming, draft: model.draftOf(incoming), conflict: false };
    if (model.patchOf(base, model.draftOf(incoming)) === null) return { base: incoming, draft, conflict: false };
    return { base, draft, conflict: true };
}

/**
 * "Keep my edits" after a conflict: the fields edited in `draft` (relative
 * to the version it started from) applied onto the latest version — the
 * rest follows what the other edit saved; where both changed a field,
 * mine wins.
 */
export function keepEditsOnWith<V, D extends object>(model: DraftModel<V, D>, base: V, draft: D, latest: V): D {
    const before = model.draftOf(base);
    const mine = Object.fromEntries(
        Object.entries(draft).filter(([key, value]) => !same(value, before[key as keyof D]))
    );
    return { ...model.draftOf(latest), ...mine };
}
