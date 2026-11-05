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
- Playback uses ffmpeg through `prism-media` (feeding `@discordjs/voice`).
  If ffmpeg is unavailable, `/voice play` still reports success and the
  failure surfaces later as an `AudioPlayer` error event (playback simply
  produces no audio) — there is no synchronous "ffmpeg not available" error.
- Connection and playback state live in memory; the bot must be re-joined
  after a restart.

## Media URL host policy

On the plugin RPC path (`src/modules/voice/voice-rpc.ts`) the bot
checks the URL's host with the host policy (`src/utils/host-policy.ts`)
before playback:

- A URL on the calling plugin's own origin (for example the radio
  plugin serving a library track) gets the plugin-target policy,
  `assertPluginTarget`.
- Any other URL gets the strict public-only policy,
  `assertPublicMediaTarget`. Loopback, private, link-local, cloud
  metadata and reserved addresses are refused.

The `/voice play` slash command checks only that the URL is `http` or
`https`; it does not run the host policy.

The check is not pinned to the addresses it vetted, and that is a
known residual risk (#144):

- ffmpeg fetches the URL itself, possibly in the separate voice
  container, and resolves the host again. A DNS answer that changes
  between check and fetch (DNS rebinding) is not caught.
- Handing ffmpeg the IP instead of the hostname would break https SNI
  and certificate checks, so pinning the check alone cannot close this.
- Larger than that window: ffmpeg follows HTTP redirects, and an HLS
  playlist can name segments on any host. Neither reaches the host
  policy.

Closing these needs a different fetch path: the bot fetches the media
over a pinned connection, vets every redirect hop, and pipes the stream
to ffmpeg. That is tracked in #158. Until then, ffmpeg is limited to
the HTTP protocol stack (`-protocol_whitelist`), so a crafted playlist
cannot reach `file:` or `concat:` inputs.

## Required bot permissions

- `View Channels`
- `Connect` and `Speak` (on the voice channel)

## Runtime requirements

- The container image bundles `ffmpeg` (installed in the bot's Dockerfile).
- For local development, ensure `ffmpeg` is on `PATH`. (Note: the relocated
  voice manager uses prism-media's resolver, which ignores the `FFMPEG_PATH`
  env var — ffmpeg must be discoverable on `PATH`.)

## Source

| File | Purpose |
|------|---------|
| `src/modules/builtin-features/voice/voice.commands.ts` | `/voice` slash command |
| `src/modules/voice/voice-backend.ts` | Backend seam — in-process vs remote (`getVoiceBackend()`) |
| `src/modules/voice/voice-rpc.ts` | Plugin → bot voice RPC entry point |
| `src/modules/voice/voice-internal-routes.ts`, `voice-gateway-relay.ts` | Bot ↔ external voice-service bridge |
| `packages/voice/src/voice-manager.ts` | Per-guild connection manager (join / leave / play / pause / stop / status) |
