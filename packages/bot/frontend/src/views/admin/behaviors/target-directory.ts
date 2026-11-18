import { computed, inject, provide, type InjectionKey, type Ref } from 'vue';
import type { BehaviorTargetKey, BehaviorTargetView } from '../../../api/behavior';
import { NO_NAMES, type TargetNames } from './target-labels';

/**
 * The Behavior Targets a form may choose from — the same list the sidebar
 * shows (ADR 0004). The page provides it; every form's target select reads
 * it, so no card has to be handed the list.
 */
export interface TargetDirectory {
    targets: Readonly<Ref<readonly BehaviorTargetView[]>>;
    names: Readonly<Ref<TargetNames>>;
    /**
     * A form created a target ("new target…" in its select): list it,
     * without moving the page away from the form's unsaved draft.
     */
    created: (target: BehaviorTargetView) => Promise<void> | void;
    /** Go to a target's page (a group's, to edit its members); asks before dropping unsaved drafts. */
    open?: (key: BehaviorTargetKey) => Promise<void> | void;
}

export const TARGET_DIRECTORY: InjectionKey<TargetDirectory> = Symbol('behavior-target-directory');

export function provideTargetDirectory(directory: TargetDirectory): void {
    provide(TARGET_DIRECTORY, directory);
}

/** Outside the page (a form mounted on its own) the directory is empty. */
const EMPTY: TargetDirectory = {
    targets: computed(() => []),
    names: computed(() => NO_NAMES),
    created: () => undefined,
};

export function useTargetDirectory(): TargetDirectory {
    return inject(TARGET_DIRECTORY, EMPTY);
}
