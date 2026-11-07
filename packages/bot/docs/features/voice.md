# Voice

Have the bot join a guild voice channel and play audio from a URL. The
feature exposes the basic controls: join, leave, play, stop, status.
Playback uses ffmpeg through `@discordjs/voice`, so any format ffmpeg can
decode (`.mp3`, `.ogg`, `.opus`, HLS streams, and so on) works as a direct
URL.

> Sources that require stream extraction (such as YouTube) are
> intentionally out of scope. A plugin can extract the stream itself and
> feed a direct URL into the bot.

Voice is also a capability surface for plugins: the `karyl-radio` plugin
operates the same per-guild connection through the voice RPC (see
[`../development/plugin-guide.md`](../development/plugin-guide.md)). The
slash command path and the plugin RPC path both go through the same
per-guild connection manager, so per-guild state stays consistent.

## Commands

`/voice` works only in guilds. Discord requires the `Manage Server`
permission, and the guild must have the `voice` feature enabled (per-guild
toggle in the admin panel). At most one voice connection per guild at a
time.

| Command | Description |
|---------|-------------|
| `/voice join` | Have the bot join the caller's current voice channel. The caller must already be in a voice channel. |
| `/voice leave` | Leave the voice channel. |
| `/voice play url:<url>` | Play an audio URL. Only `http` and `https` are accepted; other protocols (`file://`, `rtmp://`, and so on) are rejected by the slash command. Returns an error if not joined. |
| `/voice stop` | Stop playback. The connection is kept. |
| `/voice status` | Show connection and player state: connected, channel, playing, URL, connection / player status. |

All `/voice` replies are ephemeral (visible only to the caller).

## Rules

- One `VoiceConnection` per guild. A second `join` moves the bot to the
  new channel.
- Playback spawns ffmpeg (feeding `@discordjs/voice`), which fetches the
  media only through the voice media proxy (see below).
  If ffmpeg is unavailable, `/voice play` still reports success and the
  failure surfaces later as an `AudioPlayer` error event (playback simply
  produces no audio) — there is no synchronous "ffmpeg not available" error.
- Connection and playback state live in memory; the bot must be re-joined
  after a restart.

## Media URL host policy

Two layers keep a media URL off the LAN.

**Up-front check (bot).** Before playback the bot checks the URL's host
with the host policy (`src/utils/host-policy.ts`), so the user gets a
readable refusal:

- On the plugin RPC path (`src/modules/voice/voice-rpc.ts`), a URL on the
  calling plugin's own origin (for example the radio plugin serving a
  library track) gets the plugin-target policy, `assertPluginTarget`.
- Any other URL, on the RPC path and from the `/voice play` slash
  command, gets the strict public-only policy, `assertPublicMediaTarget`.
  Loopback, private, link-local, cloud metadata and reserved addresses
  are refused.

**Media proxy (voice, #158).** ffmpeg fetches the URL itself: it follows
redirects and opens whatever an HLS playlist names. So every fetch goes
through a small HTTP proxy inside `@karyl-chan/voice`
(`packages/voice/src/media-proxy.ts`), in-process or in the standalone
voice service alike:

- The proxy listens on `127.0.0.1` only. ffmpeg runs with
  `-http_proxy` pointed at it and with `no_proxy` removed from its
  environment.
- Every request — the first URL, each redirect hop, each HLS variant,
  segment and key — is vetted with the same public-only rule
  (`isPublicMediaAddress` in `@karyl-chan/voice/net`, the one the bot's
  `assertPublicMediaTarget` uses) and connected to the vetted addresses
  only (pinned: no DNS rebinding). Refusals answer 403 and are logged
  with host and port.
- The proxy never follows a redirect; it hands the 3xx back, so the next
  hop comes through it again.
- ffmpeg speaks only plain http (`-protocol_whitelist
  http,tcp,crypto,pipe,fd`). An https URL is handed to ffmpeg as
  `http://<host>.karyl-tls.invalid[:port]/…` and the proxy does the TLS
  itself, verifying the certificate for the real hostname. The proxy
  rewrites https `Location` headers and the https URIs in HLS playlists
  to that form. A URI it misses stays `https://…`, which ffmpeg cannot
  open, so a miss fails playback rather than bypassing the proxy.
- `-format_whitelist` limits ffmpeg to the demuxers playback needs (HLS,
  MPEG-TS, MP3, AAC, AC-3, Ogg, FLAC, WAV, Matroska, MP4 / MOV, WebVTT).
  DASH and concat, which open further URLs of their own, are refused.
- A plugin playing a URL on its own origin gets the plugin-target rule
  for exactly that host and port; everything else in that play stays
  public-only.

Behaviour that follows from this:

- An https station with a broken certificate (expired, self-signed,
  wrong name) no longer plays. ffmpeg used to accept those because it
  does not verify certificates by default.
- https to an IPv6 literal (`https://[2001:db8::1]/…`) cannot be carried
  through the proxy and is refused. IPv6 hostnames work.
- An HLS playlist larger than 2 MiB is refused.

## Required bot permissions

- `View Channels`
- `Connect` and `Speak` (on the voice channel)

## Runtime requirements

- The container image bundles `ffmpeg` (installed in the bot's Dockerfile).
- For local development, ensure `ffmpeg` is on `PATH`. (The voice manager
  spawns `ffmpeg` from `PATH`; the `FFMPEG_PATH` env var is not read.)

## Source

| File | Purpose |
|------|---------|
| `src/modules/builtin-features/voice/voice.commands.ts` | `/voice` slash command |
| `src/modules/voice/voice-backend.ts` | Backend seam — in-process vs remote (`getVoiceBackend()`) |
| `src/modules/voice/voice-rpc.ts` | Plugin → bot voice RPC entry point |
| `src/modules/voice/voice-internal-routes.ts`, `voice-gateway-relay.ts` | Bot ↔ external voice-service bridge |
| `packages/voice/src/voice-manager.ts` | Per-guild connection manager (join / leave / play / pause / stop / status) |
| `packages/voice/src/ffmpeg-decoder.ts` | ffmpeg arguments and environment (protocol / format whitelists, `-http_proxy`) |
| `packages/voice/src/media-proxy.ts` | The media proxy every ffmpeg fetch goes through (#158) |
| `packages/voice/src/net/` | Address classification and the media / plugin-target rules (`@karyl-chan/voice/net`) |
