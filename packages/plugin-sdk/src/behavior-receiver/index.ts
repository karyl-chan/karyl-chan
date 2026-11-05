/**
 * `@karyl-chan/plugin-sdk/behavior-receiver` — the receiving end of a
 * behavior's webhook action: verify the bot's request, sign the response
 * over the request's nonce, tell an admin test-fire apart, and test it all
 * against the protocol's golden vectors.
 *
 * Its own bundle: it loads only `node:crypto` (and `node:http` types), not
 * the SDK's main entry or fastify. The protocol is
 * packages/bot/docs/features/behavior-webhook-protocol.md.
 */
export {
  BEHAVIOR_WEBHOOK_FIXTURES,
  type BehaviorWebhookFixtures,
} from "./protocol.js";
export type { HmacGoldenVector } from "@karyl-chan/plugin-wire";
export {
  verifyRequest,
  type BehaviorAuthMode,
  type NonceStore,
  type ReceiverSecrets,
  type RequestHeaders,
  type VerifyFailureReason,
  type VerifyRequestOptions,
  type VerifyResult,
} from "./verify.js";
export { signResponse, type SignResponseOptions } from "./sign.js";
export {
  createNonceStore,
  type MemoryNonceStore,
  type NonceStoreOptions,
} from "./nonce-store.js";
export {
  createReceiver,
  type BehaviorAnswer,
  type CreateReceiverOptions,
} from "./receiver.js";
export type {
  BehaviorReply,
  BehaviorReplyActionRow,
  BehaviorReplyEmbed,
  BehaviorReplyLinkButton,
  BehaviorWebhookAttachment,
  BehaviorWebhookPayload,
  BehaviorWebhookUser,
  CommandTriggerMeta,
  CommandTriggerOption,
  MessageTriggerMeta,
  TestFireMeta,
} from "./types.js";
export type { RawBody } from "./crypto.js";
