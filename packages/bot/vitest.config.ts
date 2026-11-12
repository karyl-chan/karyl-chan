import { defineConfig } from 'vitest/config';

/**
 * Backend vitest config. Scopes the test runner to /tests so it
 * doesn't accidentally pick up the frontend's *.test.ts files (those
 * live under frontend/ with their own jsdom-based vitest config and
 * would explode here without localStorage / window).
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        env: {
            // bot_events has its own SQLite file. Unset, it resolves to
            // the package's real data/bot-events.sqlite: shared by every
            // parallel run, table-less in a fresh checkout ("no such
            // table: bot_events"), and in the main checkout the test
            // station's bind-mounted event log. A test that needs a file
            // path still sets its own in vi.hoisted.
            BOT_EVENTS_SQLITE_DB_PATH: ':memory:'
        }
    }
});
