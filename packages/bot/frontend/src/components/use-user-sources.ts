import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { listChannels } from '../api/dm';
import { listGuildMembers } from '../api/guilds';
import { hasAdminCapability, hasGuildCapability } from '../libs/admin-capabilities';
import { useCurrentUserStore } from '../stores/currentUserStore';
import { useGuildListStore } from '../stores/guildListStore';

/**
 * Where UserPicker finds a Discord user:
 *
 *   id     typed in — always there
 *   dm     the people who have DMed the bot  (GET /api/dm/channels, `dm.message`)
 *   guild  a server's members, by name       (GET /api/guilds/:id/members, that guild's `manage`)
 *
 * The list sources reuse endpoints that already exist, so a source shows
 * only to an admin who may call it — nobody gains a way to look users up
 * by being handed the picker. A refusal the capability check did not
 * foresee (403) drops the source for the rest of the page's life.
 */
export type UserSource = 'id' | 'dm' | 'guild';

export interface UserCandidate {
    id: string;
    name: string;
    /** The second line: the username, when the name shown is something else. */
    subtitle: string | null;
    avatarUrl: string | null;
    bot: boolean;
}

const isForbidden = (err: unknown) => (err as { status?: number } | null)?.status === 403;
const lower = (s: string) => s.toLocaleLowerCase();

/** Which sources the signed-in admin may use, and the servers whose members they may search. */
export function useUserSources() {
    const currentUser = useCurrentUserStore();
    const guildList = useGuildListStore();
    const denied = ref(new Set<UserSource>());

    const capabilities = computed(() => currentUser.user?.capabilities ?? []);
    const searchableGuilds = computed(() =>
        guildList.guilds.filter((g) => hasGuildCapability(capabilities.value, g.id, 'manage'))
    );
    const sources = computed<UserSource[]>(() => {
        const list: UserSource[] = ['id'];
        if (hasAdminCapability(capabilities.value, 'dm.message') && !denied.value.has('dm')) list.push('dm');
        if (searchableGuilds.value.length > 0 && !denied.value.has('guild')) list.push('guild');
        return list;
    });

    function deny(source: UserSource): void {
        denied.value = new Set([...denied.value, source]);
    }

    /** Load the guild list — only for an admin who could search some server's members. */
    async function ensureGuilds(): Promise<void> {
        const mayManageSome = capabilities.value.some(
            (cap) => cap === 'admin' || cap === 'guild.manage' || /^guild:[^.:]+\.manage$/.test(cap)
        );
        if (mayManageSome) await guildList.ensure().catch(() => undefined);
    }

    return { sources, searchableGuilds, deny, ensureGuilds };
}

/** The people who have DMed the bot, filtered by name as the admin types. */
export function useDmContacts(onDenied: () => void) {
    const contacts = ref<UserCandidate[]>([]);
    const loading = ref(false);
    const filter = ref('');
    let loaded = false;

    async function load(): Promise<void> {
        if (loaded || loading.value) return;
        loading.value = true;
        try {
            const channels = await listChannels();
            contacts.value = channels.map(({ recipient }) => ({
                id: recipient.id,
                name: recipient.globalName ?? recipient.username,
                subtitle: recipient.globalName ? recipient.username : null,
                avatarUrl: recipient.avatarUrl,
                bot: false,
            }));
            loaded = true;
        } catch (err) {
            if (isForbidden(err)) onDenied();
        } finally {
            loading.value = false;
        }
    }

    const shown = computed(() => {
        const q = lower(filter.value.trim());
        if (!q) return contacts.value;
        return contacts.value.filter(
            (c) => lower(c.name).includes(q) || lower(c.subtitle ?? '').includes(q) || c.id.includes(q)
        );
    });

    return { shown, loading, filter, load };
}

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 25;

/** A server's members matching a name, searched on the server as the admin types. */
export function useGuildMemberSearch(guildId: Ref<string>, onDenied: () => void) {
    const query = ref('');
    const results = ref<UserCandidate[]>([]);
    const loading = ref(false);
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Only the latest search may answer: an older one must not overwrite it. */
    let latest = 0;

    async function search(): Promise<void> {
        const guild = guildId.value;
        const run = ++latest;
        if (!guild) {
            results.value = [];
            return;
        }
        loading.value = true;
        try {
            const members = await listGuildMembers(guild, { limit: SEARCH_LIMIT, query: query.value.trim() || undefined });
            if (run !== latest) return;
            results.value = members.map((m) => ({
                id: m.id,
                name: m.nickname ?? m.globalName ?? m.username,
                subtitle: m.nickname || m.globalName ? m.username : null,
                avatarUrl: m.avatarUrl,
                bot: m.bot,
            }));
        } catch (err) {
            if (run !== latest) return;
            results.value = [];
            if (isForbidden(err)) onDenied();
        } finally {
            if (run === latest) loading.value = false;
        }
    }

    watch(guildId, () => void search());
    watch(query, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void search(), SEARCH_DEBOUNCE_MS);
    });
    onBeforeUnmount(() => {
        if (timer) clearTimeout(timer);
    });

    return { query, results, loading, search };
}
