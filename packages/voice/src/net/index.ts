/**
 * @karyl-chan/voice/net — side-effect-free network policy helpers.
 *
 * Address classification, the public-media rule and the pinned lookup.
 * Importable from the bot's config chain: unlike the package root (whose
 * voice manager probes for ffmpeg at load), nothing here runs on import.
 * Keep it that way — node built-ins only.
 */
export * from "./ip-address.js";
export * from "./host-vetting.js";
export * from "./media-target.js";
export * from "./pinned-lookup.js";
