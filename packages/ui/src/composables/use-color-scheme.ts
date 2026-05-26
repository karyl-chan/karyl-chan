import { ref, watch } from 'vue';

/**
 * Global colour-scheme controller.
 *
 * Tri-state, matching what most apps expose to users:
 *   - `light`  — force light tokens, regardless of system.
 *   - `dark`   — force dark tokens, regardless of system.
 *   - `system` — follow `prefers-color-scheme` (the default).
 *
 * Wired up via a `data-theme` attribute on `<html>`. The token sheet
 * (`tokens.css`) reads that attribute alongside the `prefers-color-scheme`
 * media query, so:
 *   - no attribute → media query decides
 *   - `light` → light tokens win, even under system dark
 *   - `dark` → dark tokens win, even under system light
 *
 * Persisted to localStorage so the choice survives reloads. Storage is a
 * best-effort side channel — failures (privacy mode, quota, SSR) are
 * swallowed and the in-memory state still works for the current session.
 *
 * Singleton: the ref is module-scoped, so every consumer sees the same
 * value and a write from one component fans out to all of them.
 */

export type ColorScheme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'karyl:color-scheme';

function readStored(): ColorScheme {
    if (typeof window === 'undefined') return 'system';
    try {
        const v = window.localStorage.getItem(STORAGE_KEY);
        if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch {
        // localStorage may be unavailable (privacy mode, SSR-ish env).
    }
    return 'system';
}

function apply(scheme: ColorScheme): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (scheme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', scheme);
}

const current = ref<ColorScheme>(readStored());

let initialized = false;
function init(): void {
    if (initialized) return;
    initialized = true;
    apply(current.value);
    watch(current, (v) => {
        apply(v);
        if (typeof window === 'undefined') return;
        try {
            if (v === 'system') window.localStorage.removeItem(STORAGE_KEY);
            else window.localStorage.setItem(STORAGE_KEY, v);
        } catch {
            // best-effort; in-memory state still wins for this session.
        }
    });
}

export function useColorScheme() {
    init();
    return {
        colorScheme: current,
        setColorScheme(v: ColorScheme): void {
            current.value = v;
        },
    };
}
