/**
 * Webhook action intake: an admin's `{ url, authMode }` → the encrypted
 * behavior_webhook_actions values to store (#99).
 *
 * The secret is write-only and the bot's to make: admins never send one.
 * Turning authentication on (authMode null → token / hmac) generates a
 * secret, returned to the caller once; switching between token and hmac
 * keeps it (the receiver already holds it); turning authentication off
 * drops it. A new secret for a live behavior comes from the rotation
 * endpoint instead, which keeps the old one valid for a grace period.
 *
 * The URL is checked with the same target policy the forwarder applies
 * at send time.
 */

import { createHash, randomBytes } from "crypto";
import { encryptSecret } from "../../utils/crypto.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { isValidWebhookUrl } from "./behavior-helpers.js";
import type {
  BehaviorWebhookActionRow,
  BehaviorWebhookAuthMode,
} from "./models/behavior-webhook-action.model.js";

export interface WebhookInput {
  url: string;
  authMode?: BehaviorWebhookAuthMode | null;
}

export const webhookInputSchema = {
  type: "object",
  properties: {
    url: { type: "string", minLength: 1, maxLength: 2048 },
    authMode: { enum: ["token", "hmac", null] },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

export interface WebhookWrite {
  /** behavior_webhook_actions columns (url / secret encrypted) */
  values: {
    url: string;
    secret: string | null;
    authMode: BehaviorWebhookAuthMode | null;
  };
  /** the plaintext secret, when this write generated one — shown once */
  issuedSecret: string | null;
  /** audit view of the result (no URL, no secret) */
  audit: WebhookAuditView;
}

export interface WebhookAuditView {
  urlFingerprint: string;
  authMode: BehaviorWebhookAuthMode | null;
  secretSet: boolean;
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Audit stand-in for a webhook URL: a short SHA-256 fingerprint, enough to
 * tell "the URL changed" and to match a known URL, without storing one
 * (URLs often embed a token).
 */
export function webhookUrlFingerprint(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

export async function prepareWebhookWrite(
  input: WebhookInput,
  existing: BehaviorWebhookActionRow | null,
  field = "webhook",
): Promise<WebhookWrite> {
  const verdict = await isValidWebhookUrl(input.url);
  if (!verdict.ok) {
    throw new BehaviorApiError(
      "validation_failed",
      `${verdict.reason} (${verdict.code})`,
      `${field}.url`,
    );
  }

  const authMode =
    input.authMode !== undefined ? input.authMode : (existing?.authMode ?? null);
  let secret: string | null = null;
  let issuedSecret: string | null = null;
  if (authMode !== null) {
    if (existing?.secret) {
      secret = existing.secret;
    } else {
      issuedSecret = generateWebhookSecret();
      secret = encryptSecret(issuedSecret);
    }
  }

  return {
    values: { url: encryptSecret(input.url), secret, authMode },
    issuedSecret,
    audit: {
      urlFingerprint: webhookUrlFingerprint(input.url),
      authMode,
      secretSet: secret !== null,
    },
  };
}
