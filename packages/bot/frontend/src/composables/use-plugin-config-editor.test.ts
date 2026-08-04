/**
 * #31 — the plugin config editor's behaviour, which used to live pasted
 * three times inside .vue files (PluginCard, PluginDetailConfig,
 * GuildBotFeaturesPanel) and was therefore untestable.
 *
 * The three copies had genuinely diverged; the cases below pin each
 * divergence to the side of it that the extraction settled on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick } from 'vue';
import {
    SAVED_BADGE_MS,
    SECRET_SENTINEL,
    isConfigStale,
    seedConfigValues,
    toFieldErrorMap,
    usePluginConfigEditor,
    type PluginConfigSnapshot,
} from './use-plugin-config-editor';
import { ConfigValidationError, type PluginConfigField } from '../api/plugins';

function field(over: Partial<PluginConfigField> & { key: string }): PluginConfigField {
    return { type: 'text', label: over.key, ...over };
}

describe('seedConfigValues — stored values', () => {
    it('keeps stored strings as-is and stringifies non-strings', () => {
        const out = seedConfigValues({
            schema: [field({ key: 'a' }), field({ key: 'n', type: 'number' })],
            values: { a: 'hi', n: 42 },
        });
        expect(out).toEqual({ a: 'hi', n: '42' });
    });

    it('normalises booleans from either JSON booleans or their string form', () => {
        const schema = [field({ key: 'b', type: 'boolean' })];
        expect(seedConfigValues({ schema, values: { b: true } }).b).toBe('true');
        expect(seedConfigValues({ schema, values: { b: 'true' } }).b).toBe('true');
        expect(seedConfigValues({ schema, values: { b: false } }).b).toBe('false');
        expect(seedConfigValues({ schema, values: { b: 'nonsense' } }).b).toBe('false');
    });

    it('shows a stored secret as the sentinel and never leaks the stored bytes', () => {
        // The plugin-level API masks secrets server-side ("********"); the
        // per-guild payload carries the encrypted blob. Both must render as
        // the sentinel, which the bot reads back as "leave it alone".
        const schema = [field({ key: 's', type: 'secret' })];
        expect(seedConfigValues({ schema, values: { s: SECRET_SENTINEL } }).s).toBe(SECRET_SENTINEL);
        expect(seedConfigValues({ schema, values: { s: 'a1b2c3-ciphertext' } }).s).toBe(SECRET_SENTINEL);
    });

    it('treats an unset secret as empty, never as its default', () => {
        const schema = [field({ key: 's', type: 'secret', default: 'hunter2' })];
        expect(seedConfigValues({ schema, values: {} }, { seedDefaults: true }).s).toBe('');
        expect(seedConfigValues({ schema, values: { s: null } }).s).toBe('');
    });

    it('drops keys the schema no longer declares', () => {
        const out = seedConfigValues({ schema: [field({ key: 'a' })], values: { a: '1', gone: '2' } });
        expect(out).toEqual({ a: '1' });
    });
});

describe('seedConfigValues — unset fields (the divergence between the three copies)', () => {
    const schema = [
        field({ key: 't', default: 'fallback' }),
        field({ key: 'n', type: 'number', default: 5 }),
        field({ key: 'b', type: 'boolean', default: true }),
    ];

    it('leaves unset fields blank when the source does not seed defaults', () => {
        // Plugin-level config: the bot serves the schema to the plugin
        // alongside stored values, so the PLUGIN applies its own defaults.
        // Pre-filling here would freeze today's default into the DB on the
        // next save. `null` is how the bot spells "no stored row".
        const out = seedConfigValues({ schema, values: { t: null, n: null, b: null } });
        expect(out).toEqual({ t: '', n: '', b: '' });
    });

    it('pre-fills manifest defaults — including booleans — when the source asks for it', () => {
        // Per-guild feature config pre-fills, which is what the panel always
        // did for text/number. Booleans were the outlier: they ignored the
        // default and rendered OFF, so an untouched save wrote `false` over
        // a default-on option.
        const out = seedConfigValues({ schema, values: {} }, { seedDefaults: true });
        expect(out).toEqual({ t: 'fallback', n: '5', b: 'true' });
    });

    it('stringifies a non-string default instead of passing the raw JSON through', () => {
        const out = seedConfigValues(
            { schema: [field({ key: 'n', type: 'number', default: 5 })], values: {} },
            { seedDefaults: true },
        );
        expect(out.n).toBe('5');
        expect(typeof out.n).toBe('string');
    });

    it('falls back to empty when there is no default at all', () => {
        const out = seedConfigValues(
            { schema: [field({ key: 'x' }), field({ key: 'b', type: 'boolean' })], values: {} },
            { seedDefaults: true },
        );
        expect(out).toEqual({ x: '', b: 'false' });
    });
});

describe('isConfigStale', () => {
    const base = { schema: [], values: {} };
    it('is stale only when the stored version is behind the manifest version', () => {
        expect(isConfigStale({ ...base, storedConfigSchemaVersion: 1, configSchemaVersion: 2 })).toBe(true);
        expect(isConfigStale({ ...base, storedConfigSchemaVersion: 2, configSchemaVersion: 2 })).toBe(false);
        expect(isConfigStale({ ...base, storedConfigSchemaVersion: 3, configSchemaVersion: 2 })).toBe(false);
    });

    it('is never stale when either version is missing', () => {
        expect(isConfigStale({ ...base, storedConfigSchemaVersion: null, configSchemaVersion: 2 })).toBe(false);
        expect(isConfigStale({ ...base, storedConfigSchemaVersion: 1, configSchemaVersion: null })).toBe(false);
        expect(isConfigStale(base)).toBe(false);
    });
});

describe('toFieldErrorMap', () => {
    it('keys 422 field errors by field key', () => {
        expect(
            toFieldErrorMap([
                { key: 'a', message: 'required', code: 'required' },
                { key: 'b', message: 'nope', code: 'pattern' },
            ]),
        ).toEqual({ a: 'required', b: 'nope' });
    });
});

// ─── the composable ──────────────────────────────────────────────────

const SCHEMA: PluginConfigField[] = [
    field({ key: 'token', type: 'secret' }),
    field({ key: 'name' }),
];

function snapshot(over: Partial<PluginConfigSnapshot> = {}): PluginConfigSnapshot {
    return { schema: SCHEMA, values: { token: SECRET_SENTINEL, name: 'karyl' }, ...over };
}

/** Run a composable inside a scope so onScopeDispose-registered timers die with it. */
function inScope<T>(fn: () => T): { value: T; stop: () => void } {
    const scope = effectScope();
    const value = scope.run(fn)!;
    return { value, stop: () => scope.stop() };
}

describe('usePluginConfigEditor', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('loads, seeds the form and reports the schema-drift warning', async () => {
        const load = vi.fn().mockResolvedValue(snapshot({ storedConfigSchemaVersion: 1, configSchemaVersion: 2 }));
        const { value: e } = inScope(() => usePluginConfigEditor({ load, save: vi.fn() }));

        await e.load();

        expect(e.fields.value).toEqual(SCHEMA);
        expect(e.values).toEqual({ token: SECRET_SENTINEL, name: 'karyl' });
        expect(e.stale.value).toBe(true);
        expect(e.loaded.value).toBe(true);
        expect(e.dirty.value).toBe(false);
    });

    it('loads once — a second call is a no-op while loaded', async () => {
        const load = vi.fn().mockResolvedValue(snapshot());
        const { value: e } = inScope(() => usePluginConfigEditor({ load, save: vi.fn() }));
        await e.load();
        await e.load();
        expect(load).toHaveBeenCalledTimes(1);
        await e.load({ force: true });
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('re-seeding drops keys from the previous schema instead of merging them', async () => {
        const load = vi
            .fn()
            .mockResolvedValueOnce(snapshot())
            .mockResolvedValueOnce({ schema: [field({ key: 'other' })], values: { other: 'x' } });
        const { value: e } = inScope(() => usePluginConfigEditor({ load, save: vi.fn() }));
        await e.load();
        await e.load({ force: true });
        expect(e.values).toEqual({ other: 'x' });
    });

    it('surfaces a load failure as the editor error', async () => {
        const load = vi.fn().mockRejectedValue(new Error('boom'));
        const { value: e } = inScope(() => usePluginConfigEditor({ load, save: vi.fn() }));
        await e.load();
        expect(e.error.value).toBe('boom');
        expect(e.loaded.value).toBe(false);
        expect(e.loading.value).toBe(false);
    });

    it('tracks dirty against the last seeded / last saved values', async () => {
        const save = vi.fn().mockResolvedValue(undefined);
        const { value: e } = inScope(() => usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save }));
        await e.load();
        expect(e.dirty.value).toBe(false);

        e.values.name = 'karyl2';
        expect(e.dirty.value).toBe(true);

        e.values.name = 'karyl';
        expect(e.dirty.value).toBe(false);

        e.values.name = 'karyl3';
        await e.save();
        expect(e.dirty.value).toBe(false);
    });

    it('sends the whole form — sentinel secrets included — and clears stale on success', async () => {
        const save = vi.fn().mockResolvedValue(undefined);
        const { value: e } = inScope(() =>
            usePluginConfigEditor({
                load: () => Promise.resolve(snapshot({ storedConfigSchemaVersion: 1, configSchemaVersion: 2 })),
                save,
            }),
        );
        await e.load();
        expect(e.stale.value).toBe(true);

        const ok = await e.save();

        expect(ok).toBe(true);
        expect(save).toHaveBeenCalledWith({ token: SECRET_SENTINEL, name: 'karyl' });
        // A copy, not the live reactive object.
        expect(save.mock.calls[0]![0]).not.toBe(e.values);
        expect(e.stale.value).toBe(false);
        expect(e.error.value).toBeNull();
    });

    it('shows the saved badge for exactly SAVED_BADGE_MS, then hides it', async () => {
        const { value: e } = inScope(() =>
            usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save: vi.fn().mockResolvedValue(undefined) }),
        );
        await e.load();
        await e.save();
        expect(e.saved.value).toBe(true);

        vi.advanceTimersByTime(SAVED_BADGE_MS - 1);
        expect(e.saved.value).toBe(true);
        vi.advanceTimersByTime(1);
        expect(e.saved.value).toBe(false);
    });

    it('a second save restarts the badge window rather than letting the first timer end it early', async () => {
        const { value: e } = inScope(() =>
            usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save: vi.fn().mockResolvedValue(undefined) }),
        );
        await e.load();
        await e.save();
        vi.advanceTimersByTime(SAVED_BADGE_MS - 100);
        await e.save();
        vi.advanceTimersByTime(200);
        expect(e.saved.value).toBe(true);
    });

    it('maps a 422 to per-field errors and counts them, without a banner message', async () => {
        const save = vi
            .fn()
            .mockRejectedValue(
                new ConfigValidationError('config validation failed', [
                    { key: 'name', message: 'is required', code: 'required' },
                    { key: 'token', message: 'too short', code: 'length' },
                ]),
            );
        const { value: e } = inScope(() => usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save }));
        await e.load();

        const ok = await e.save();

        expect(ok).toBe(false);
        expect(e.fieldErrors).toEqual({ name: 'is required', token: 'too short' });
        expect(e.invalidCount.value).toBe(2);
        // The wording of "N fields have errors" is the caller's (i18n) job.
        expect(e.error.value).toBeNull();
        expect(e.saved.value).toBe(false);
    });

    it('clears stale field errors on the next save attempt', async () => {
        const save = vi
            .fn()
            .mockRejectedValueOnce(
                new ConfigValidationError('nope', [{ key: 'name', message: 'is required', code: 'required' }]),
            )
            .mockResolvedValueOnce(undefined);
        const { value: e } = inScope(() => usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save }));
        await e.load();
        await e.save();
        expect(e.invalidCount.value).toBe(1);

        await e.save();
        expect(e.invalidCount.value).toBe(0);
        expect(e.fieldErrors).toEqual({});
    });

    it('reports a non-422 save failure as a message', async () => {
        const save = vi.fn().mockRejectedValue(new Error('502 bad gateway'));
        const { value: e } = inScope(() => usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save }));
        await e.load();
        expect(await e.save()).toBe(false);
        expect(e.error.value).toBe('502 bad gateway');
    });

    it('lets a source swallow errors it handles elsewhere (401 → auth redirect)', async () => {
        const describeError = vi.fn().mockReturnValue(null);
        const save = vi.fn().mockRejectedValue(new Error('401'));
        const { value: e } = inScope(() =>
            usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save, describeError }),
        );
        await e.load();
        await e.save();
        expect(describeError).toHaveBeenCalled();
        expect(e.error.value).toBeNull();
    });

    it('never runs two saves at once', async () => {
        let release!: () => void;
        const save = vi.fn().mockImplementation(() => new Promise<void>((r) => { release = r; }));
        const { value: e } = inScope(() => usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save }));
        await e.load();

        const first = e.save();
        await nextTick();
        expect(e.saving.value).toBe(true);
        const second = await e.save();
        expect(second).toBe(false);
        expect(save).toHaveBeenCalledTimes(1);

        release();
        await first;
        expect(e.saving.value).toBe(false);
    });

    it('apply() seeds from a payload the caller already fetched', async () => {
        const { value: e } = inScope(() => usePluginConfigEditor({ save: vi.fn() }));
        e.apply(snapshot({ storedConfigSchemaVersion: 1, configSchemaVersion: 3 }));
        expect(e.values).toEqual({ token: SECRET_SENTINEL, name: 'karyl' });
        expect(e.stale.value).toBe(true);
        expect(e.loaded.value).toBe(true);
    });

    it('reset() empties everything so a different plugin cannot inherit the last one’s form', async () => {
        const save = vi
            .fn()
            .mockRejectedValue(new ConfigValidationError('nope', [{ key: 'name', message: 'x', code: 'required' }]));
        const { value: e } = inScope(() =>
            usePluginConfigEditor({
                load: () => Promise.resolve(snapshot({ storedConfigSchemaVersion: 1, configSchemaVersion: 2 })),
                save,
            }),
        );
        await e.load();
        await e.save();

        e.reset();

        expect(e.values).toEqual({});
        expect(e.fields.value).toEqual([]);
        expect(e.fieldErrors).toEqual({});
        expect(e.stale.value).toBe(false);
        expect(e.saved.value).toBe(false);
        expect(e.error.value).toBeNull();
        expect(e.loaded.value).toBe(false);
    });

    it('honours the source’s seedDefaults choice on load', async () => {
        const schema = [field({ key: 'b', type: 'boolean', default: true })];
        const { value: seeded } = inScope(() =>
            usePluginConfigEditor({ load: () => Promise.resolve({ schema, values: {} }), save: vi.fn(), seedDefaults: true }),
        );
        await seeded.load();
        expect(seeded.values.b).toBe('true');

        const { value: bare } = inScope(() =>
            usePluginConfigEditor({ load: () => Promise.resolve({ schema, values: {} }), save: vi.fn() }),
        );
        await bare.load();
        expect(bare.values.b).toBe('');
    });

    it('drops the badge timer when its scope is disposed', async () => {
        const { value: e, stop } = inScope(() =>
            usePluginConfigEditor({ load: () => Promise.resolve(snapshot()), save: vi.fn().mockResolvedValue(undefined) }),
        );
        await e.load();
        await e.save();
        stop();
        expect(vi.getTimerCount()).toBe(0);
    });
});
