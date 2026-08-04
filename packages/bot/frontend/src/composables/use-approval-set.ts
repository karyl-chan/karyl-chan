import {
    computed,
    getCurrentScope,
    onScopeDispose,
    ref,
    type ComputedRef,
    type Ref,
} from 'vue';

/**
 * "The manifest asked for these; the operator grants a subset."
 *
 * PluginDetailSecurity ran two structurally identical copies of this —
 * RPC scopes (PM-3.2) and global event subscriptions (PM-8) — differing
 * only in which endpoint they PUT to (#31).
 *
 * The grant is not a delta: the whole approved set goes over the wire and
 * the bot clamps it to what the manifest actually requests, so the
 * response is the new truth and both `approved` and the checkboxes are
 * re-seeded from it.
 */

/** How long the save button reads "saved" after a successful grant. */
export const APPROVAL_SAVED_FLASH_MS = 2000;

/** Set comparison — the checkbox order is meaningless. */
export function selectionDiffers(a: string[], b: string[]): boolean {
    const left = new Set(a);
    const right = new Set(b);
    if (left.size !== right.size) return true;
    for (const v of left) if (!right.has(v)) return true;
    return false;
}

export interface ApprovalSetSource {
    /** What the manifest declares (getter — it is derived from a prop). */
    requested: () => string[];
    /** What is already granted. Read once, at setup. */
    approved: () => string[];
    /** PUT the full approved set; returns the state the bot settled on. */
    save: (approved: string[]) => Promise<{ approved: string[] }>;
}

export interface ApprovalSet {
    requested: ComputedRef<string[]>;
    /** Currently granted. */
    approved: Ref<string[]>;
    /** The checkbox model — what a save would grant. */
    checked: Ref<string[]>;
    /** Checkboxes differ from what is granted. */
    dirty: ComputedRef<boolean>;
    /** Requested but not yet granted. */
    pendingCount: ComputedRef<number>;
    saving: Ref<boolean>;
    saved: Ref<boolean>;
    error: Ref<string | null>;
    isApproved: (value: string) => boolean;
    approveAll: () => void;
    /** Returns true when the grant was persisted. */
    save: () => Promise<boolean>;
}

export function useApprovalSet(source: ApprovalSetSource): ApprovalSet {
    const requested = computed(() => source.requested());
    const initial = [...source.approved()];
    const approved = ref<string[]>([...initial]);
    const checked = ref<string[]>([...initial]);
    const saving = ref(false);
    const saved = ref(false);
    const error = ref<string | null>(null);

    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    function clearFlash(): void {
        if (flashTimer !== null) {
            clearTimeout(flashTimer);
            flashTimer = null;
        }
    }
    if (getCurrentScope()) onScopeDispose(clearFlash);

    const dirty = computed(() => selectionDiffers(checked.value, approved.value));
    const pendingCount = computed(
        () => requested.value.filter((v) => !approved.value.includes(v)).length,
    );

    function isApproved(value: string): boolean {
        return approved.value.includes(value);
    }

    function approveAll(): void {
        checked.value = [...requested.value];
    }

    async function save(): Promise<boolean> {
        if (saving.value || !dirty.value) return false;
        saving.value = true;
        error.value = null;
        try {
            const state = await source.save([...checked.value]);
            approved.value = [...state.approved];
            checked.value = [...state.approved];
            saved.value = true;
            clearFlash();
            flashTimer = setTimeout(() => {
                saved.value = false;
                flashTimer = null;
            }, APPROVAL_SAVED_FLASH_MS);
            return true;
        } catch (err) {
            error.value = err instanceof Error ? err.message : String(err);
            return false;
        } finally {
            saving.value = false;
        }
    }

    return {
        requested,
        approved,
        checked,
        dirty,
        pendingCount,
        saving,
        saved,
        error,
        isApproved,
        approveAll,
        save,
    };
}
