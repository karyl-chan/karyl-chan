/**
 * Voice connection manager — one VoiceConnection per guild.
 *
 * Relocated from the bot (PR-2.3c) so a single implementation backs both the
 * in-process backend (single-machine default) and the standalone voice
 * service. Framework-free: no Fastify, no discord.js Client, no bot config /
 * logger — it takes a `DiscordGatewayAdapterCreator` per join (the in-process
 * backend passes `guild.voiceAdapterCreator`; the service passes the
 * GatewayBridge's adapter) and logs via a pluggable sink.
 *
 * @discordjs/voice handles the gateway voice handshake and the UDP audio
 * relay; we track which guild has an active connection and give a thin facade
 * for join/leave/play/stop. Audio playback spawns ffmpeg (ffmpeg-decoder.ts)
 * to decode direct .mp3 / .ogg / .opus URLs, HLS streams, etc. — fetching
 * only through the per-process media proxy (media-proxy.ts), which vets and
 * pins every request ffmpeg makes (#158). YouTube extraction is
 * intentionally out of scope; plugins feed us a direct URL.
 *
 * The admission-control cap (MAX_CONCURRENT_VOICE_GUILDS) lives here so it
 * applies wherever the manager runs.
 */
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import { execSync, type ChildProcess } from "node:child_process";
import { PassThrough, pipeline, type Readable } from "node:stream";
import { spawnFfmpegDecoder } from "./ffmpeg-decoder.js";
import { startMediaProxy, type MediaProxy } from "./media-proxy.js";
import { mediaPolicyFor } from "./net/media-target.js";

// ─── Logging ──────────────────────────────────────────────────────────
//
// The manager is consumed by the bot (pino) and by the standalone service
// (console). Rather than hard-wire either, it logs through a small structured
// sink that defaults to console and can be overridden via `setVoiceLogger`.

export interface VoiceLogger {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
}

let log: VoiceLogger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: "info", msg, ...asObj(obj) })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: "warn", msg, ...asObj(obj) })),
  error: (obj, msg) => console.error(JSON.stringify({ level: "error", msg, ...asObj(obj) })),
};

function asObj(obj: unknown): Record<string, unknown> {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : { value: obj };
}

/** Override the manager's log sink (the bot wires its pino module logger). */
export function setVoiceLogger(logger: VoiceLogger): void {
  log = logger;
}

// ffmpeg comes from PATH (both the bot image and the voice image
// apt-install it; we don't ship ffmpeg-static, which segfaults on Debian
// Trixie). We spawn it ourselves rather than through prism-media's FFmpeg,
// which cannot take an env: the child must run without `no_proxy` (see
// ffmpeg-decoder.ts).
const ffmpegCommand: string = (() => {
  let resolved: string | null = null;
  try {
    const fromPath = execSync("command -v ffmpeg 2>/dev/null", {
      encoding: "utf8",
    }).trim();
    if (fromPath) resolved = fromPath;
  } catch {
    // No system ffmpeg — voice playback will fail at first /play.
  }
  log.info({ ffmpegPath: resolved }, "voice-manager: ffmpeg resolved");
  return resolved ?? "ffmpeg";
})();

// Late-bound so setVoiceLogger applies to the proxies too.
const proxyLog = { warn: (obj: unknown, msg: string) => log.warn(obj, msg) };

// One media proxy per process (public-media policy), started on first play
// and reused; closed by shutdownAllVoice. A failed start is not cached, so
// the next play retries.
let mediaProxy: Promise<MediaProxy> | null = null;
// Per-play proxies (plays with a trustedOrigin), open while their ffmpeg runs.
const playProxies = new Set<MediaProxy>();

function getMediaProxy(): Promise<MediaProxy> {
  mediaProxy ??= startMediaProxy({ log: proxyLog }).catch((err: unknown) => {
    mediaProxy = null;
    throw err;
  });
  return mediaProxy;
}

interface GuildVoiceState {
  connection: VoiceConnection;
  player: AudioPlayer;
  channelId: string;
  /** The URL currently being played, if any. */
  playingUrl: string | null;
}

const states = new Map<string, GuildVoiceState>();

/** Information about the current voice state for a guild. */
export interface VoiceStatus {
  connected: boolean;
  channelId: string | null;
  playing: boolean;
  /** True when the player is user-paused (Paused — not AutoPaused, which
   *  just means nobody's listening). `playing` stays true while paused. */
  paused: boolean;
  playingUrl: string | null;
  /** Reflects @discordjs/voice's connection status string. */
  connectionStatus: string | null;
  /** Reflects @discordjs/voice's player status string. */
  playerStatus: string | null;
  /**
   * Non-bot members currently in the bot's voice channel. Filled in by the
   * `voice.status` RPC in the bot (it has the discord.js client; this manager
   * does not) — `undefined` when not connected or the channel can't be
   * inspected. `0` means the bot is alone.
   */
  listeners?: number;
}

export interface JoinOptions {
  guildId: string;
  channelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  selfDeaf?: boolean;
  selfMute?: boolean;
}

/**
 * Cap concurrent voice guild connections. Each connection allocates a
 * `VoiceConnection` plus an ffmpeg child process on every `play()`; running
 * unbounded at 2500-guild scale is the primary OOM risk. Reject new joins
 * with a sentinel that the RPC layer / service translates to HTTP 429.
 *
 * Default 50. Override with `MAX_CONCURRENT_VOICE_GUILDS=N`.
 */
const MAX_CONCURRENT_VOICE_GUILDS = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_VOICE_GUILDS ?? "50", 10) || 50,
);

export class VoiceCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceCapacityError";
  }
}

/**
 * Join a guild voice channel. Idempotent: if already connected to the same
 * channel, returns the existing state. If connected to a different channel in
 * the same guild, transparently moves.
 */
export async function joinVoice(opts: JoinOptions): Promise<VoiceStatus> {
  const { guildId, channelId, adapterCreator, selfDeaf, selfMute } = opts;
  log.info({ guildId, channelId, selfDeaf, selfMute }, "joinVoice called");
  const existing = states.get(guildId);
  if (existing && existing.channelId === channelId) {
    return getStatus(guildId);
  }
  // Refuse new guilds when the cap is hit. Same-guild moves (existing != null)
  // bypass the cap — the slot is already accounted for.
  if (!existing && states.size >= MAX_CONCURRENT_VOICE_GUILDS) {
    throw new VoiceCapacityError(
      `concurrent voice guilds at cap (${MAX_CONCURRENT_VOICE_GUILDS})`,
    );
  }
  if (existing) {
    // Move to a different channel in the same guild — destroy old, recreate.
    existing.connection.destroy();
    existing.player.stop(true);
    states.delete(guildId);
  }
  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: selfDeaf ?? true,
    selfMute: selfMute ?? false,
  });
  const player = createAudioPlayer();
  connection.subscribe(player);

  // Disconnect handling — Discord can drop the connection (gateway resume
  // failure, channel deleted). Try one rejoin; if that fails, tear down so
  // the next join() starts clean.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      log.warn({ guildId, channelId }, "voice connection lost, destroying");
      connection.destroy();
      player.stop(true);
      states.delete(guildId);
    }
  });

  states.set(guildId, {
    connection,
    player,
    channelId,
    playingUrl: null,
  });
  // Register player observability ONCE per player. Doing it per-play (in
  // playUrl) leaked a stateChange + error listener on every skip: a skip
  // calls player.play() on an already-playing player, which @discordjs/voice
  // does NOT route through Idle, so the per-play once(Idle) cleanup never
  // fired → MaxListenersExceededWarning + every stale handler re-firing.
  attachPlayerObservability(player, guildId);

  // Wait up to 15s for the connection to be ready. If we time out we still
  // leave the state in the map so subsequent calls (e.g. /leave) can clean
  // up; we surface a logical "connected: false" via the connection status.
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    log.error({ err, guildId, channelId }, "voice connection failed to ready");
  }
  return getStatus(guildId);
}

/**
 * Attach the per-player observability + playingUrl-reset listeners. Called
 * exactly once per player (at joinVoice) — the player outlives individual
 * plays, so registering here (not per-play) keeps the listener count bounded
 * regardless of how many tracks are skipped. Exported for testing.
 */
export function attachPlayerObservability(
  player: AudioPlayer,
  guildId: string,
): void {
  player.on("stateChange", (oldState, newState) => {
    log.info(
      {
        guildId,
        url: states.get(guildId)?.playingUrl,
        from: oldState.status,
        to: newState.status,
      },
      "audio player state change",
    );
  });
  player.on("error", (err) => {
    log.error(
      { err, guildId, url: states.get(guildId)?.playingUrl },
      "audio player error",
    );
  });
  // Idle = no active resource (track ended / stopped). A skip swaps the
  // resource WITHOUT an Idle transition, so this only fires on a genuine end.
  player.on(AudioPlayerStatus.Idle, () => {
    const s = states.get(guildId);
    if (s) s.playingUrl = null;
  });
}

/** Leave the guild voice channel. No-op if not connected. */
export function leaveVoice(guildId: string): VoiceStatus {
  const state = states.get(guildId);
  if (!state) return getStatus(guildId);
  state.player.stop(true);
  state.connection.destroy();
  states.delete(guildId);
  return getStatus(guildId);
}

export interface PlayOptions {
  /**
   * Origin (`http://host:port`) of the plugin asking to play a URL on its
   * own HTTP surface (e.g. the radio plugin's `/internal/audio/…`), which
   * the caller vetted with the plugin-target policy. Requests to exactly
   * that host and port may then reach a docker-internal address; every
   * other request of the play stays under the public-media rule.
   */
  trustedOrigin?: string;
}

/**
 * Stream-decode and play an audio URL. Resolves once the player accepts the
 * resource — playback continues in the background. Replaces any
 * currently-playing track. Caller must already be joined via joinVoice()
 * (else rejects with `not_joined`).
 *
 * Async only because the media proxy starts lazily. A play with a
 * `trustedOrigin` gets its own proxy (its policy differs), closed when its
 * ffmpeg exits.
 */
export async function playUrl(
  guildId: string,
  url: string,
  options: PlayOptions = {},
): Promise<VoiceStatus> {
  if (!states.has(guildId)) {
    throw new Error("not_joined");
  }
  const ownProxy = options.trustedOrigin
    ? await startMediaProxy({
        resolveTarget: mediaPolicyFor(options.trustedOrigin),
        log: proxyLog,
      })
    : null;
  if (ownProxy) playProxies.add(ownProxy);
  const proxy = ownProxy ?? (await getMediaProxy());
  const closeOwnProxy = (): void => {
    if (!ownProxy || !playProxies.delete(ownProxy)) return;
    ownProxy
      .close()
      .catch((err: unknown) => log.warn({ err }, "media proxy close failed"));
  };
  // Re-read: a leave may have landed while the proxy was starting.
  const state = states.get(guildId);
  if (!state) {
    closeOwnProxy();
    throw new Error("not_joined");
  }
  // Spawn ffmpeg: input from URL (through the media proxy only), resampled
  // to 48kHz stereo PCM (Discord's native rate) on stdout. The protocol /
  // format whitelists and the proxy wiring live in ffmpeg-decoder.ts.
  let child: ChildProcess;
  try {
    child = spawnFfmpegDecoder({
      command: ffmpegCommand,
      url,
      proxyUrl: proxy.url,
    });
  } catch (err) {
    closeOwnProxy();
    throw err;
  }
  child.on("close", closeOwnProxy);
  child.stderr?.on("data", (b: Buffer) => {
    const text = b.toString("utf8").trim();
    if (text) log.warn({ url, guildId, ffmpeg: text }, "ffmpeg stderr");
  });
  // A ~2 s PCM jitter buffer between ffmpeg and the audio player. pipeline()
  // ties their lifecycles: an ffmpeg error/EOF tears down the buffer, and the
  // buffer being destroyed (player swapping in the next track) ends the
  // pipeline with an error, on which we kill the ffmpeg child — so a skip
  // never leaks a zombie ffmpeg.
  const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;
  const buffered = new PassThrough({ highWaterMark: PCM_BYTES_PER_SECOND * 2 });
  child.on("error", (err) => {
    // Spawn failure (no ffmpeg on PATH) — end the track instead of hanging.
    log.error({ err, url, guildId }, "ffmpeg failed to start");
    buffered.destroy(err);
  });
  // stdio is ["ignore", "pipe", "pipe"], so stdout is always a stream.
  pipeline(child.stdout as Readable, buffered, (err) => {
    if (err) child.kill("SIGKILL");
    // ERR_STREAM_PREMATURE_CLOSE just means the player swapped this track out
    // (skip / stop / leave) and destroyed the buffer — expected.
    if (
      err &&
      (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE"
    ) {
      log.warn({ err, url, guildId }, "ffmpeg → playback buffer error");
    }
  });
  const resource = createAudioResource(buffered, {
    inputType: StreamType.Raw,
  });
  log.info(
    { url, guildId, channelId: state.channelId },
    "playUrl: spawning ffmpeg + queueing resource",
  );
  // Player observability + playingUrl reset are registered once per player in
  // joinVoice (attachPlayerObservability) — NOT here. Registering per-play
  // leaked a listener pair on every skip (play() on an already-playing player
  // doesn't transition through Idle, so the per-play cleanup never ran).
  state.player.play(resource);
  state.playingUrl = url;
  return getStatus(guildId);
}

export function stopPlayback(guildId: string): VoiceStatus {
  const state = states.get(guildId);
  if (!state) return getStatus(guildId);
  state.player.stop(true);
  state.playingUrl = null;
  return getStatus(guildId);
}

/**
 * Pause / resume the current track. `paused` undefined → toggle. No-op
 * (returns the current status) if not joined or nothing is playing.
 */
export function pausePlayback(guildId: string, paused?: boolean): VoiceStatus {
  const state = states.get(guildId);
  if (!state) return getStatus(guildId);
  const isPaused = state.player.state.status === AudioPlayerStatus.Paused;
  const want = paused ?? !isPaused;
  if (want) state.player.pause(true);
  else state.player.unpause();
  return getStatus(guildId);
}

export function getStatus(guildId: string): VoiceStatus {
  const state = states.get(guildId);
  if (!state) {
    return {
      connected: false,
      channelId: null,
      playing: false,
      paused: false,
      playingUrl: null,
      connectionStatus: null,
      playerStatus: null,
    };
  }
  return {
    connected: state.connection.state.status === VoiceConnectionStatus.Ready,
    channelId: state.channelId,
    paused: state.player.state.status === AudioPlayerStatus.Paused,
    // "playing" = the player currently holds an audio resource — any state
    // that isn't Idle (Playing, Buffering, AutoPaused, Paused). Reporting only
    // `=== Playing` made callers "advance" past a track during the 1–3 s
    // ffmpeg startup.
    playing: state.player.state.status !== AudioPlayerStatus.Idle,
    playingUrl: state.playingUrl,
    connectionStatus: state.connection.state.status,
    playerStatus: state.player.state.status,
  };
}

/**
 * Tear down all active voice connections and the media proxy (graceful
 * shutdown / tests). The proxy closes in the background; a later play
 * starts a fresh one.
 */
export function shutdownAllVoice(): void {
  const proxy = mediaProxy;
  mediaProxy = null;
  const closing = [
    ...(proxy ? [proxy.then((p) => p.close())] : []),
    ...[...playProxies].map((p) => p.close()),
  ];
  playProxies.clear();
  for (const c of closing) {
    c.catch((err: unknown) => log.warn({ err }, "media proxy shutdown failed"));
  }
  for (const [guildId, state] of states.entries()) {
    try {
      state.player.stop(true);
      state.connection.destroy();
    } catch (err) {
      log.warn({ err, guildId }, "error during voice shutdown");
    }
  }
  states.clear();
}
