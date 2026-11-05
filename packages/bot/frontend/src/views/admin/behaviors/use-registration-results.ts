import { computed, inject, provide, ref, type InjectionKey, type Ref, type WritableComputedRef } from 'vue';
import type { RegistrationResult } from './registration-result';

/**
 * What the last write to each command did on Discord, kept by the page:
 * a save that moves a command to another section unmounts its card and
 * opens a new one there, which must still say what Discord answered.
 */
const KEY: InjectionKey<Ref<Map<number, RegistrationResult>>> = Symbol('command-registration-results');

export function provideRegistrationResults(): void {
    provide(KEY, ref(new Map()));
}

/** The command's last registration result (null when none); without a provider it lives with the card. */
export function useRegistrationResult(commandId: () => number): WritableComputedRef<RegistrationResult | null> {
    const results = inject(KEY, null) ?? ref(new Map<number, RegistrationResult>());
    return computed({
        get: () => results.value.get(commandId()) ?? null,
        set: (result) => {
            const next = new Map(results.value);
            if (result) next.set(commandId(), result);
            else next.delete(commandId());
            results.value = next;
        },
    });
}
