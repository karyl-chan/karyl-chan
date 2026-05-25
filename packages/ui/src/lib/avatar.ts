// Discord CDN avatar / banner helpers.
//
// Discord encodes animated assets with an `a_` hash prefix. The `.webp`
// endpoint serves the still frame by default and the animated variant
// when `&animated=true` is appended (Discord CDN honours this query
// parameter; the .gif endpoint returns 415 for many assets so we stay
// on .webp). Consumers opt into animation selectively — hover on a
// list row vs. always-playing inside a profile card.

/**
 * True if the URL points at an animated avatar — either global
 * (`/avatars/<userId>/a_…`) or guild-specific
 * (`/guilds/<gid>/users/<uid>/avatars/a_…`).
 */
export function isAnimatedAvatar(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\/avatars\/(?:\d+\/)?a_/.test(url);
}

/** True if the URL points at an animated banner. */
export function isAnimatedBanner(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\/banners\/\d+\/a_/.test(url);
}

/**
 * Append `animated=true` so the Discord CDN returns the animated frame.
 * Idempotent if the caller already added it; callers should still gate
 * via `isAnimatedAvatar` / `isAnimatedBanner` first — appending the
 * param to a still-only asset is a wasted request.
 */
export function animatedAvatarUrl(url: string): string {
  if (/[?&]animated=true(?:&|$)/.test(url)) return url;
  return url.includes("?") ? `${url}&animated=true` : `${url}?animated=true`;
}
