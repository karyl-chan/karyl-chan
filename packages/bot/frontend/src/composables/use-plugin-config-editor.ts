import {
    computed,
    getCurrentScope,
    onScopeDispose,
    reactive,
    ref,
    type ComputedRef,
    type Ref,
} from 'vue';
import {
    ConfigValidationError,
    type FieldValidationError,
    type PluginConfigField,
    type PluginConfigPayload,
} from '../api/plugins';

/**
 * The behaviour behind a plugin `config_schema` form: seed the fields
 * from stored values, flag config-schema drift, save, and turn a 422
 * into per-field markers.
 *
 * `PluginConfigFields.vue` was extracted markup-only, so this half was
 * pasted into three components — PluginCard (card inline), PluginDetail
 * Config (設定 tab) and GuildBotFeaturesPanel (per-guild feature row) —
 * where none of it could be tested (#31). The copies had drifted; the
 * differences that survived are the ones a *source* declares below.
 *
 * The caller keeps its own chrome (when to load, where the errors
 * render, what the buttons say) and hands over a source adapter.
 */

/**
 * A secret the bot already holds. Both config surfaces render it as the
 * field's value, and a save that sends it back means "leave the stored
 * value alone" — the bot skips the key instead of re-encrypting the
 * placeholder. Must stay byte-identical to the bot's SECRET_SENTINEL.
 */
export const SECRET_SENTINEL = '********';

/** How long the "已儲存 / Saved" badge stays up after a successful save. */
export const SAVED_BADGE_MS = 4000;

/** Stored config as the editor wants it, whoever fetched it. */
export interface PluginConfigSnapshot {
    schema: PluginConfigField[];
    /**
     * Stored values keyed by field key. `null`/`undefined`/absent all mean
     * "nothing stored for this field" — the bot's plugin-level payload
     * spells that as an explicit `null`, the per-guild payload simply
     * omits the key.
     */
    values: Record<string, unknown>;
    /** The manifest's current `config_schema_version` (PD-4.3). */
    configSchemaVersion?: number | null;
    /** The version the stored config was last saved under (PD-4.3). */
    storedConfigSchemaVersion?: number | null;
}

/**
 * Adapt the plugin-level config payload (`GET /config`, and the `config`
 * half of `GET /settings`) to a snapshot. The bot emits one entry per
 * schema field, with `value: null` for a field that has no stored row.
 */
export function fromPluginConfigPayload(payload: PluginConfigPayload): PluginConfigSnapshot {
    const values: Record<string, unknown> = {};
    for (const v of payload.values) values[v.key] = v.value;
    return {
        schema: payload.schema,
        values,
        configSchemaVersion: payload.configSchemaVersion,
        storedConfigSchemaVersion: payload.storedConfigSchemaVersion,
    };
}

export interface SeedOptions {
    /**
     * Pre-fill fields that have no stored value with the manifest default.
     *
     * OFF for plugin-level config: `config.get` hands the plugin the schema
     * along with the stored rows, so the *plugin* applies its own defaults.
     * Pre-filling the admin form would freeze today's default into the DB
     * on the next save and the plugin would stop tracking manifest changes.
     *
     * ON for per-guild feature config, which has always pre-filled — the
     * row is written wholesale, and an operator opening a feature's config
     * expects to see the values that are actually in effect.
     */
    seedDefaults?: boolean;
}

/**
 * Turn a stored-config snapshot into the string-keyed form model
 * `PluginConfigFields.vue` binds to. Every value is a string: booleans
 * as `'true'`/`'false'`, unset as `''`.
 */
export function seedConfigValues(
    snapshot: PluginConfigSnapshot,
    opts: SeedOptions = {},
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of snapshot.schema) {
        const raw = snapshot.values[field.key];
        const stored = raw !== null && raw !== undefined;

        // Secrets never fall back to a default: the only two states worth
        // rendering are "the bot holds one" and "empty".
        if (field.type === 'secret') {
            out[field.key] =
                stored && typeof raw === 'string' && raw.length > 0 ? SECRET_SENTINEL : '';
            continue;
        }
        if (stored) {
            out[field.key] =
                field.type === 'boolean'
                    ? raw === true || raw === 'true'
                        ? 'true'
                        : 'false'
                    : String(raw);
            continue;
        }
        if (!opts.seedDefaults) {
            out[field.key] = '';
            continue;
        }
        const fallback = field.default;
        out[field.key] =
            field.type === 'boolean'
                ? fallback === true || fallback === 'true'
                    ? 'true'
                    : 'false'
                : fallback == null
                  ? ''
                  : String(fallback);
    }
    return out;
}

/**
 * PD-4.3: the stored admin config was saved under an older
 * `config_schema_version` than the manifest now declares, so the values
 * may no longer mean what the operator intended. Only a *known* pair of
 * versions can be stale — a plugin that declares no version never is.
 */
export function isConfigStale(snapshot: PluginConfigSnapshot): boolean {
    const stored = snapshot.storedConfigSchemaVersion;
    const current = snapshot.configSchemaVersion;
    return stored != null && current != null && stored < current;
}

/** 422 field errors → the `fieldErrors` map PluginConfigFields renders. */
export function toFieldErrorMap(errors: FieldValidationError[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const e of errors) map[e.key] = e.message;
    return map;
}

/** Where the editor's values come from and go to. */
export interface PluginConfigSource extends SeedOptions {
    /**
     * Fetch the stored config. Optional: a caller that already has the
     * payload (PluginDetailConfig fetches it inside a bigger request;
     * GuildBotFeaturesPanel has it in memory) seeds with `apply()`.
     */
    load?: () => Promise<PluginConfigSnapshot> | PluginConfigSnapshot;
    /** Persist the whole form. Rejects with ConfigValidationError on 422. */
    save: (values: Record<string, string>) => Promise<unknown>;
    /**
     * Turn a non-422 failure into the message to show, or `null` to stay
     * quiet because the caller already handled it (GuildBotFeaturesPanel
     * routes 401/403 through `useApiError`, which redirects).
     */
    describeError?: (err: unknown) => string | null;
}

export interface PluginConfigEditor {
    /** The schema being rendered. */
    fields: Ref<PluginConfigField[]>;
    /** The form model — bound by reference into PluginConfigFields. */
    values: Record<string, string>;
    /** Field key → 422 message. */
    fieldErrors: Record<string, string>;
    /** Edited since the last seed / successful save. */
    dirty: ComputedRef<boolean>;
    /** Stored config predates the manifest's config_schema_version. */
    stale: Ref<boolean>;
    /** How many fields the last save came back complaining about. */
    invalidCount: ComputedRef<number>;
    loading: Ref<boolean>;
    loaded: Ref<boolean>;
    saving: Ref<boolean>;
    /** True for SAVED_BADGE_MS after a successful save. */
    saved: Ref<boolean>;
    /** Load/save failure that is not a 422, already turned into a message. */
    error: Ref<string | null>;
    load: (opts?: { force?: boolean }) => Promise<void>;
    apply: (snapshot: PluginConfigSnapshot) => void;
    reset: () => void;
    /** Returns true when the values were persisted. */
    save: () => Promise<boolean>;
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function usePluginConfigEditor(source: PluginConfigSource): PluginConfigEditor {
    const fields = ref<PluginConfigField[]>([]);
    const values = reactive<Record<string, string>>({});
    const fieldErrors = reactive<Record<string, string>>({});
    const stale = ref(false);
    const loading = ref(false);
    const loaded = ref(false);
    const saving = ref(false);
    const saved = ref(false);
    const error = ref<string | null>(null);

    /** The values as last seeded or last persisted — what `dirty` compares to. */
    const baseline = ref<Record<string, string>>({});
    let savedTimer: ReturnType<typeof setTimeout> | null = null;

    function clearSavedTimer(): void {
        if (savedTimer !== null) {
            clearTimeout(savedTimer);
            savedTimer = null;
        }
    }
    if (getCurrentScope()) onScopeDispose(clearSavedTimer);

    function replaceValues(next: Record<string, string>): void {
        // Replace, never merge: a re-seed after a schema change (or after
        // switching plugin) must not leave the previous schema's keys in the
        // form, where they would be POSTed back as unknown keys.
        for (const k of Object.keys(values)) delete values[k];
        Object.assign(values, next);
        baseline.value = { ...next };
    }

    function clearFieldErrors(): void {
        for (const k of Object.keys(fieldErrors)) delete fieldErrors[k];
    }

    const dirty = computed(() => {
        const base = baseline.value;
        const keys = Object.keys(values);
        if (keys.length !== Object.keys(base).length) return true;
        return keys.some((k) => values[k] !== base[k]);
    });

    const invalidCount = computed(() => Object.keys(fieldErrors).length);

    function apply(snapshot: PluginConfigSnapshot): void {
        fields.value = snapshot.schema;
        stale.value = isConfigStale(snapshot);
        replaceValues(seedConfigValues(snapshot, { seedDefaults: source.seedDefaults }));
        clearFieldErrors();
        error.value = null;
        loaded.value = true;
    }

    function reset(): void {
        clearSavedTimer();
        fields.value = [];
        replaceValues({});
        clearFieldErrors();
        stale.value = false;
        saved.value = false;
        error.value = null;
        loaded.value = false;
    }

    async function load(opts: { force?: boolean } = {}): Promise<void> {
        if (!source.load) return;
        // Lazily loaded surfaces (the card expands) call this on every open;
        // the in-memory state is the cache.
        if (loading.value || (loaded.value && !opts.force)) return;
        loading.value = true;
        error.value = null;
        try {
            apply(await source.load());
        } catch (err) {
            error.value = source.describeError ? source.describeError(err) : messageOf(err);
        } finally {
            loading.value = false;
        }
    }

    async function save(): Promise<boolean> {
        if (saving.value) return false;
        saving.value = true;
        error.value = null;
        clearFieldErrors();
        try {
            // Send the whole form, sentinel secrets included — the bot skips
            // a secret still holding the sentinel, so an untouched secret
            // stays encrypted at rest instead of being re-written.
            const payload = { ...values };
            await source.save(payload);
            baseline.value = payload;
            stale.value = false;
            saved.value = true;
            clearSavedTimer();
            savedTimer = setTimeout(() => {
                saved.value = false;
                savedTimer = null;
            }, SAVED_BADGE_MS);
            return true;
        } catch (err) {
            if (err instanceof ConfigValidationError) {
                Object.assign(fieldErrors, toFieldErrorMap(err.fieldErrors));
            } else {
                error.value = source.describeError ? source.describeError(err) : messageOf(err);
            }
            return false;
        } finally {
            saving.value = false;
        }
    }

    return {
        fields,
        values,
        fieldErrors,
        dirty,
        stale,
        invalidCount,
        loading,
        loaded,
        saving,
        saved,
        error,
        load,
        apply,
        reset,
        save,
    };
}
