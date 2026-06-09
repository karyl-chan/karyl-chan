/**
 * playUrl used to register a stateChange + error listener (plus a once(Idle)
 * cleanup) on the shared AudioPlayer on EVERY call. A skip (play() on an
 * already-playing player) does not transition through Idle in @discordjs/voice,
 * so the per-play cleanup never fired and listeners accumulated → Node's
 * MaxListenersExceededWarning + every stale handler re-firing.
 *
 * The observability listeners now live in attachPlayerObservability, called
 * exactly once per player at joinVoice. This locks that registration to a
 * bounded set (one of each), so playUrl can be called any number of times
 * without growing the listener count.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createAudioPlayer, AudioPlayerStatus } from "@discordjs/voice";
import { attachPlayerObservability } from "../src/voice-manager.js";

describe("voice-manager player observability", () => {
  it("registers exactly one stateChange + error + Idle listener per player", () => {
    const player = createAudioPlayer();
    // A fresh player carries no observability listeners of ours.
    assert.equal(player.listenerCount("stateChange"), 0);
    assert.equal(player.listenerCount("error"), 0);

    attachPlayerObservability(player, "guild-1");

    assert.equal(player.listenerCount("stateChange"), 1);
    assert.equal(player.listenerCount("error"), 1);
    assert.equal(player.listenerCount(AudioPlayerStatus.Idle), 1);
  });
});
