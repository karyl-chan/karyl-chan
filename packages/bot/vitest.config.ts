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
        // Each run defaults to one worker per CPU (minus one). Several
        // full runs at once — parallel worktrees, parallel agents —
        // oversubscribe the CPU that many times over, and the heavier
        // tests then cross their 5 s / 10 s budgets (#235). When running
        // N suites side by side, give each its share:
        //   KARYL_TEST_MAX_WORKERS=<cores / N> pnpm run test
        // Unset (CI, a single local run) keeps vitest's default.
        maxWorkers: process.env.KARYL_TEST_MAX_WORKERS || undefined,
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
