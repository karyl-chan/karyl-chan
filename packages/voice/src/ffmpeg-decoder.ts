/**
 * ffmpeg-decoder — how the voice manager runs ffmpeg on a media URL, kept
 * apart from the manager so the integration test spawns exactly what
 * playback spawns.
 *
 * The containment (#158) is three locks; each one alone is not enough:
 *
 *   1. `-protocol_whitelist http,tcp,crypto,pipe,fd`. No https / tls /
 *      httpproxy / file / data: ffmpeg can open only plain http (plus
 *      tcp underneath it, crypto for AES-HLS wrapping http, pipe / fd for
 *      the PCM output). An https URL anywhere — first URL, redirect,
 *      playlist — fails instead of connecting. The hls demuxer only
 *      accepts segment schemes starting with "file" / "http" (crypto
 *      wraps those), so `tcp://` / `tls://` segments are refused by
 *      ffmpeg itself; `httpproxy://` would pass that check, which is why
 *      it is not whitelisted (verified on 8.1; same check in 4.3 hls.c).
 *   2. `-http_proxy <media proxy>`, and the same proxy as the child's only
 *      proxy variable: `no_proxy` (and the rest) removed, `http_proxy`
 *      set. ffmpeg's http protocol consults `getenv("no_proxy")` even
 *      when the option is set, so an inherited `no_proxy` would make it
 *      connect directly; and it falls back to `getenv("http_proxy")`
 *      when the option is absent, so a nested open that ever failed to
 *      inherit the option would still use the proxy rather than dial out.
 *      With both, every http request ffmpeg makes — including each
 *      redirect hop and each HLS variant / segment / key, which inherit
 *      `http_proxy` through the hls demuxer's saved avio options — goes
 *      to the media proxy, which vets and pins it. https upstreams reach
 *      the proxy as marker-encoded http URLs (`toProxyUrl`).
 *   3. `-format_whitelist` (defence in depth): only the demuxers radio /
 *      file / HLS playback needs. Notably no `dash` and no `concat`,
 *      which open further URLs of their own. Every listed demuxer exists
 *      in ffmpeg 4.3 (production) and 8.1.
 *
 * A decoder is bound to its proxy's lifetime: it is never started against
 * a closed proxy, and closing the proxy kills it. Otherwise a long
 * `-reconnect` could find the closed proxy's ephemeral port reused by a
 * later proxy with another policy (a per-play `trustedOrigin` one).
 *
 * Residual: a server can still make ffmpeg spend time and bandwidth
 * within the public internet (that is what playing a URL means).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { toProxyUrl, type MediaProxy } from "./media-proxy.js";

export const FFMPEG_PROTOCOL_WHITELIST = "http,tcp,crypto,pipe,fd";

/**
 * Demuxer names for `-format_whitelist`. ffmpeg matches any name of a
 * multi-name demuxer, so `mov` covers mov,mp4,m4a,3gp and `matroska`
 * covers matroska,webm. hls copies the list to its segment demuxers, so
 * the segment formats (mpegts, aac, mov for fMP4, webvtt subtitles) are
 * here too.
 */
export const FFMPEG_FORMAT_WHITELIST = [
  "hls",
  "mpegts",
  "mp3",
  "aac",
  "ac3",
  "eac3",
  "ogg",
  "flac",
  "wav",
  "matroska",
  "mov",
  "webvtt",
].join(",");

const PROXY_ENV = new Set(["no_proxy", "http_proxy", "https_proxy", "all_proxy"]);

/**
 * The child's environment: the parent's minus every proxy variable (any
 * case — Windows env names are case-insensitive), plus `http_proxy` =
 * the media proxy. The parent's process.env is not touched.
 */
export function ffmpegChildEnv(
  proxyUrl: string,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (!PROXY_ENV.has(name.toLowerCase())) env[name] = value;
  }
  env.http_proxy = proxyUrl;
  return env;
}

/**
 * Decode `url` to 48 kHz stereo s16le PCM on stdout, fetching only through
 * the media proxy at `proxyUrl`. Throws for a URL that cannot be carried
 * through the proxy (not http(s), or https to an IPv6 literal).
 */
export function ffmpegDecodeArgs(url: string, proxyUrl: string): string[] {
  const input = toProxyUrl(url);
  if (!input) throw new Error("unsupported_media_url");
  return [
    "-protocol_whitelist",
    FFMPEG_PROTOCOL_WHITELIST,
    "-format_whitelist",
    FFMPEG_FORMAT_WHITELIST,
    "-http_proxy",
    proxyUrl,
    // -reconnect keeps long radio streams alive across transient blips.
    // -rw_timeout bounds a single input I/O wait (10s) so ffmpeg errors
    // out instead of hanging on a dead connection; -reconnect then retries.
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-rw_timeout",
    "10000000",
    "-loglevel",
    "error",
    "-i",
    input,
    "-analyzeduration",
    "0",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ];
}

export interface SpawnDecoderOptions {
  /** ffmpeg binary. Default `ffmpeg` (PATH). */
  command?: string;
  url: string;
  /** The media proxy the decoder fetches through, and lives no longer than. */
  proxy: MediaProxy;
  /** Base environment (proxy variables are stripped). Default process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn the decoder: stdout is the PCM, stderr ffmpeg's log, no stdin.
 * Throws `media_proxy_closed` when the proxy is already closed; the child
 * is SIGKILLed when the proxy closes.
 */
export function spawnFfmpegDecoder({
  command = "ffmpeg",
  url,
  proxy,
  env,
}: SpawnDecoderOptions): ChildProcess {
  if (proxy.closed) throw new Error("media_proxy_closed");
  const args = ffmpegDecodeArgs(url, proxy.url);
  const child = spawn(command, args, {
    env: ffmpegChildEnv(proxy.url, env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const unsubscribe = proxy.onClose(() => child.kill("SIGKILL"));
  child.once("close", unsubscribe);
  child.once("error", unsubscribe);
  return child;
}
