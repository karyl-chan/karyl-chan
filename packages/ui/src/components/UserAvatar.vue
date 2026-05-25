<script setup lang="ts">
/**
 * UserAvatar — circular avatar `<img>` with letter-initial fallback.
 *
 * Three animation modes:
 * - `animate="never"` (default): always serve the still frame.
 * - `animate="hover"`: still by default, animated while the cursor is
 *   over the avatar — matches Discord's DM-list behaviour. The hover
 *   state is owned internally; if the caller needs hover state for
 *   other reasons, drive it via `animated` prop instead.
 * - `animate="always"`: always animated (e.g. inside an open profile
 *   card where the user is actively looking at the avatar).
 *
 * The "is this asset animated?" check is automatic — non-animated
 * Discord URLs ignore the `&animated=true` param, so we don't need
 * to special-case them in the consumer.
 */
import { computed, ref } from 'vue';
import { animatedAvatarUrl, isAnimatedAvatar } from '../lib/avatar';

const props = withDefaults(defineProps<{
    /** Avatar URL (Discord CDN, or anything else). Null/undefined → fallback. */
    src?: string | null;
    /** Used to derive the fallback letter when there's no `src`. */
    name?: string | null;
    /** Pixel size of the circle. Default 40. */
    size?: number;
    /** When and how to swap to the animated variant. */
    animate?: 'never' | 'hover' | 'always';
    /**
     * Force-override for the "is hovered" half of `animate: hover`.
     * Lets the parent share hover state across multiple avatars
     * (e.g. one row hover lighting up all avatars in that row).
     */
    animated?: boolean;
    /** Alt text. Default empty (avatars are decorative when paired with a label). */
    alt?: string;
}>(), {
    src: null,
    name: null,
    size: 40,
    animate: 'never',
    animated: undefined,
    alt: '',
});

const localHover = ref(false);

const effectiveSrc = computed<string | null>(() => {
    if (!props.src) return null;
    if (!isAnimatedAvatar(props.src)) return props.src;
    const shouldAnimate =
        props.animate === 'always' ||
        (props.animate === 'hover' && (props.animated ?? localHover.value));
    return shouldAnimate ? animatedAvatarUrl(props.src) : props.src;
});

const initial = computed<string>(() => {
    const source = (props.name ?? props.alt ?? '').trim();
    if (!source) return '?';
    // Take the first grapheme — covers CJK / emoji single-char display
    // names where charAt(0) would split a surrogate pair.
    return [...source][0]?.toUpperCase() ?? '?';
});

const sizeStyle = computed(() => ({
    width: `${props.size}px`,
    height: `${props.size}px`,
    fontSize: `${Math.round(props.size * 0.42)}px`,
}));
</script>

<template>
    <div
        class="user-avatar"
        :class="{ 'has-image': !!effectiveSrc }"
        :style="sizeStyle"
        @mouseenter="localHover = true"
        @mouseleave="localHover = false"
    >
        <img
            v-if="effectiveSrc"
            :src="effectiveSrc"
            :alt="alt"
            draggable="false"
        />
        <span v-else aria-hidden="true">{{ initial }}</span>
    </div>
</template>

<style scoped>
.user-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    overflow: hidden;
    background: var(--accent);
    color: var(--text-on-accent);
    font-weight: 600;
    line-height: 1;
    flex-shrink: 0;
    user-select: none;
}
.user-avatar.has-image {
    background: var(--bg-surface-2);
}
.user-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}
</style>
