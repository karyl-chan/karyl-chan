<script setup lang="ts">
/**
 * UserCard — full user profile card with banner, animated avatar,
 * display name, tag line, and slot-driven extras.
 *
 * Pure presentation. Mirror of the bot's DiscordUserCard chrome but
 * with no store / router / api coupling — caller passes the resolved
 * values directly.
 *
 * Animation defaults to `always` (banner + avatar) because the card
 * is typically opened from a deliberate click — the user wants to
 * see the animated asset they came here for. Override per-instance
 * with `avatarAnimate` / `bannerAnimate`.
 *
 * Slots:
 * - `#facts`: key/value rows under the name. Use a `<dl class="facts">`
 *   inside, or anything you want.
 * - `#actions`: a row of buttons under the facts (e.g. "Send DM").
 * - `#default`: free-form content area appended to the body, useful
 *   for plugin-specific extras (recent activity, last seen, etc.).
 */
import { computed } from 'vue';
import { animatedAvatarUrl, isAnimatedBanner } from '../lib/avatar';
import UserAvatar from './UserAvatar.vue';

const props = withDefaults(defineProps<{
    name: string;
    /** Optional secondary display line (server-profile vs. global name divergence). */
    nickname?: string | null;
    /** `@username` (no `@` needed — the component renders the prefix). */
    username?: string | null;
    /** Discriminator (`#1234`). Rendered alongside `username` if set. */
    discriminator?: string | null;
    /** Avatar URL — animated detection auto-handled by UserAvatar. */
    avatarUrl?: string | null;
    /** Banner URL — animated detection auto-handled here. */
    bannerUrl?: string | null;
    /** Discord accent colour (24-bit integer). Used when there's no banner. */
    accentColor?: number | null;
    /** Renders a 'BOT' tag next to the name. */
    isBot?: boolean;
    /** Avatar animation mode. Default `always`. */
    avatarAnimate?: 'never' | 'hover' | 'always';
    /** Banner animation mode. Default `always`. */
    bannerAnimate?: 'never' | 'hover' | 'always';
    /** Skeleton mode — shows shimmer placeholders for name / facts. */
    loading?: boolean;
    /** Optional inline error message. */
    error?: string | null;
}>(), {
    nickname: null,
    username: null,
    discriminator: null,
    avatarUrl: null,
    bannerUrl: null,
    accentColor: null,
    isBot: false,
    avatarAnimate: 'always',
    bannerAnimate: 'always',
    loading: false,
    error: null,
});

defineSlots<{
    facts?: (props: Record<string, never>) => unknown;
    actions?: (props: Record<string, never>) => unknown;
    default?: (props: Record<string, never>) => unknown;
}>();

const bannerStyle = computed(() => {
    if (props.loading) return { backgroundColor: 'var(--bg-surface-2)' };
    if (props.bannerUrl) {
        const animated =
            props.bannerAnimate === 'always' && isAnimatedBanner(props.bannerUrl);
        const url = animated ? animatedAvatarUrl(props.bannerUrl) : props.bannerUrl;
        return { backgroundImage: `url(${url})` };
    }
    if (typeof props.accentColor === 'number') {
        return {
            backgroundColor: `#${props.accentColor.toString(16).padStart(6, '0')}`,
        };
    }
    return { backgroundColor: 'var(--accent)' };
});

const showNicknameLine = computed(
    () =>
        !!props.nickname &&
        !!props.username &&
        props.nickname !== props.username &&
        props.nickname !== props.name,
);
</script>

<template>
    <div :class="['user-card', { 'is-loading': loading }]">
        <div :class="['banner', { 'skeleton-block': loading }]" :style="bannerStyle"></div>

        <div class="avatar-wrap">
            <UserAvatar
                :src="avatarUrl"
                :name="name"
                :size="72"
                :animate="avatarAnimate"
                class="avatar-ring"
            />
        </div>

        <div class="body">
            <template v-if="loading">
                <div class="skeleton-line skeleton-block skeleton-name"></div>
                <div class="skeleton-line skeleton-block skeleton-tag"></div>
                <div class="skeleton-line skeleton-block skeleton-facts"></div>
            </template>

            <template v-else>
                <p v-if="error" class="error">{{ error }}</p>

                <div class="headline">
                    <span class="display-name">{{ name }}</span>
                    <span v-if="isBot" class="bot-tag">BOT</span>
                </div>

                <div v-if="showNicknameLine" class="nickname">
                    {{ nickname }}
                </div>

                <div v-if="username" class="tagline">
                    <span class="tag">@{{ username }}<span v-if="discriminator">#{{ discriminator }}</span></span>
                </div>

                <div v-if="$slots.facts" class="facts-slot">
                    <slot name="facts" />
                </div>

                <div v-if="$slots.actions" class="actions">
                    <slot name="actions" />
                </div>

                <div v-if="$slots.default" class="extra">
                    <slot />
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.user-card {
    width: 300px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
    overflow: hidden;
}
@media (max-width: 768px) {
    .user-card {
        width: 100%;
        border: none;
        border-radius: 0;
        box-shadow: none;
    }
}

.banner {
    height: 102px;
    background-size: cover;
    background-position: center;
    background-color: var(--accent);
}

.avatar-wrap {
    position: relative;
    margin-top: -32px;
    margin-left: 14px;
    width: 72px;
    height: 72px;
}
:deep(.avatar-ring) {
    border: 4px solid var(--bg-surface);
    background: var(--bg-surface-2);
    /* The 4px ring is part of the visual; UserAvatar's own background
       is overridden so the ring colour doesn't bleed through on the
       letter-fallback path. */
}

.body {
    padding: 0.2rem 0.9rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}

.headline {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
}
.display-name {
    font-weight: 700;
    font-size: 1.05rem;
    color: var(--text-strong);
    overflow-wrap: anywhere;
}
.bot-tag {
    background: var(--accent);
    color: var(--text-on-accent);
    font-size: 0.65rem;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    line-height: 1.2;
}
.nickname {
    color: var(--text);
    font-size: 0.9rem;
    margin-top: -0.2rem;
}
.tagline {
    color: var(--text-muted);
    font-size: 0.85rem;
}
.tag {
    overflow-wrap: anywhere;
}

.facts-slot {
    margin-top: 0.3rem;
}
.actions {
    margin-top: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
}
.extra {
    margin-top: 0.4rem;
    border-top: 1px solid var(--border);
    padding-top: 0.5rem;
    color: var(--text);
    font-size: 0.85rem;
}

.skeleton-block {
    background-color: var(--bg-surface-2);
    background-image: linear-gradient(
        90deg,
        var(--bg-surface-2) 0%,
        var(--bg-surface-hover, rgba(255, 255, 255, 0.08)) 50%,
        var(--bg-surface-2) 100%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.2s linear infinite;
}
@keyframes skeleton-shimmer {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
}
.skeleton-line {
    height: 0.9rem;
    border-radius: var(--radius-sm);
}
.skeleton-name { width: 55%; margin-top: 0.3rem; }
.skeleton-tag { width: 35%; }
.skeleton-facts { width: 70%; margin-top: 0.4rem; }

.error {
    color: var(--danger);
    margin: 0.3rem 0;
    font-size: 0.85rem;
}
</style>
