import { computed, ref, watch, type Ref } from 'vue';
import type { BehaviorTargetView } from '../../../api/behavior';
import { listGuildTextChannels } from '../../../api/guilds';
import { useUserSummaries } from '../../../composables/use-user-summaries';
import { useGuildListStore } from '../../../stores/guildListStore';
import type { TargetNames } from './target-labels';

/**
 * The names the targets on the page show: guilds from the guild list,
 * channels from each targeted guild's text channels, users from the user
 * summaries. Every one is a nicety — without the access to read it (or
 * without Discord) the target shows its id.
 */
export function useTargetNames(targets: Readonly<Ref<readonly BehaviorTargetView[]>>): Readonly<Ref<TargetNames>> {
    const guildList = useGuildListStore();
    void guildList.ensure().catch(() => undefined);

    const channels = ref(new Map<string, string>());
    const asked = new Set<string>();
    watch(
        () => [...new Set(targets.value.filter((t) => t.kind === 'channel').map((t) => t.guildId ?? ''))],
        (guildIds) => {
            for (const guildId of guildIds) {
                if (!guildId || asked.has(guildId)) continue;
                asked.add(guildId);
                listGuildTextChannels(guildId)
                    .then((categories) => {
                        const next = new Map(channels.value);
                        for (const category of categories) {
                            for (const channel of category.channels) next.set(channel.id, channel.name);
                        }
                        channels.value = next;
                    })
                    .catch(() => undefined);
            }
        },
        { immediate: true }
    );

    const userIds = computed(() => targets.value.flatMap((t) => (t.kind === 'user' && t.userId ? [t.userId] : [])));
    const { getDisplayName } = useUserSummaries(userIds);

    return computed(() => ({
        guilds: new Map(guildList.guilds.map((g) => [g.id, g.name])),
        channels: channels.value,
        user: getDisplayName,
    }));
}
