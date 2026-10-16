import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * Vitest config for @karyl-chan/ui. jsdom is the default environment so
 * the composable tests (which touch `document`) and the component tests
 * (mounted via @vue/test-utils) share one config. Tests live next to
 * the source they cover (`src/**\/*.test.ts`).
 */
export default defineConfig({
    plugins: [vue()],
    test: {
        environment: 'jsdom',
        globals: false,
        include: ['src/**/*.test.ts'],
        setupFiles: ['./vitest.setup.ts'],
        css: false
    }
});
