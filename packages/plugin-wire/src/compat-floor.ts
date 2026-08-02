/**
 * The Compat Floor: the oldest `@karyl-chan/plugin-sdk` release the bot
 * commits to interoperating with.
 *
 * Today the floor is set by the nonced dispatch HMAC scheme (BH-2.4, SDK
 * 0.10.0): an older SDK verifies `<METHOD>:<path>:<ts>:<body>` while the
 * bot signs `<METHOD>:<path>:<ts>:<nonce>:<body>`, so every dispatch is
 * rejected with 401 while register/heartbeat (which don't cross that
 * path) stay green — the 2026-06-11 incident signature. Bump this
 * whenever the wire format breaks again.
 *
 * It lives HERE, in the Wire Contract, because every consumer of the
 * floor is a statement about the wire and they must not be able to
 * disagree: the bot's sdkCompat verdict (and the admin health badge
 * rendered from it), and the SDK's `@karyl-chan/plugin-sdk-prev` alias,
 * which pins the exact release the cross-version contract test proves
 * still interops. That test asserts the pin equals this constant, so a
 * floor bump that forgets the pin fails CI in the same PR rather than
 * quietly leaving the proof pointed at an unsupported version.
 */
export const COMPAT_FLOOR: string = "0.10.0";
