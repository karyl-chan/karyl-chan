/**
 * The behavior webhook protocol's constants, read from the one place they
 * are written: `CONTRACT_FIXTURES.behaviorWebhook` in
 * `@karyl-chan/plugin-wire`. The SDK's build vendors that module into the
 * `behavior-receiver` bundle (docs/adr/0001), so nothing here is a copy
 * and the published package needs no plugin-wire at runtime.
 */
import {
  CONTRACT_FIXTURES,
  type ContractFixtures,
} from "@karyl-chan/plugin-wire";

/** The machine-readable behavior webhook contract: headers, keys, limits, golden vectors. */
export type BehaviorWebhookFixtures = ContractFixtures["behaviorWebhook"];

/**
 * The behavior webhook contract fixtures, as the bot's own tests replay
 * them. Test a receiver against `signing.requestGolden`,
 * `signing.testGolden`, `signing.responseGolden` and
 * `signing.testResponseGolden`.
 */
export const BEHAVIOR_WEBHOOK_FIXTURES: BehaviorWebhookFixtures =
  CONTRACT_FIXTURES.behaviorWebhook;

const signing = BEHAVIOR_WEBHOOK_FIXTURES.signing;

// Captured once, so a caller that mutates the exported fixtures cannot
// change how this module verifies.
export const PROTOCOL = Object.freeze({
  signatureHeader: signing.signatureHeader,
  previousSignatureHeader: signing.previousSignatureHeader,
  timestampHeader: signing.timestampHeader,
  nonceHeader: signing.nonceHeader,
  tokenHeader: signing.tokenHeader,
  previousTokenHeader: signing.previousTokenHeader,
  testHeader: signing.testHeader,
  testTokenHeader: signing.testTokenHeader,
  testPreviousTokenHeader: signing.testPreviousTokenHeader,
  testPrefix: signing.testPrefix,
  replayWindowSeconds: signing.replayWindowSeconds,
});
