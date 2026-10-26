/**
 * POST /api/behaviors/:id/webhook-secret/rotate (#99).
 *
 * Generates a new webhook secret for a behavior whose webhook
 * authenticates (token or hmac), returns it once, and keeps the secret it
 * replaces valid for ROTATION_GRACE_MS: the forwarder keeps signing the
 * standard headers with the new secret and adds the old one's version in
 * a `-previous` header, and accepts a response signed with either (see
 * webhook-forwarder.service.ts). A second rotation inside the grace
 * period keeps only the secret it replaced.
 */

import type { FastifyInstance } from "fastify";
import { encryptSecret } from "../../utils/crypto.js";
import { BehaviorApiError } from "./behavior-api-error.js";
import { auditBehaviorWrite } from "./behavior-audit.js";
import { idParams, parseRowId } from "./behavior-schemas.js";
import { behaviorTransaction, withBehaviorWriteLock } from "./behavior-write-lock.js";
import { loadBehaviorRow, refuseSystem } from "./behavior-write-routes.js";
import { BehaviorWebhookAction } from "./models/behavior-webhook-action.model.js";
import { generateWebhookSecret } from "./webhook-action-input.js";

/** How long the replaced secret still verifies. */
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

export function registerWebhookSecretRotateRoute(server: FastifyInstance): void {
  server.post(
    "/api/behaviors/:id/webhook-secret/rotate",
    { schema: { params: idParams } },
    async (request, reply) => {
      const id = parseRowId(request.params);
      const secret = generateWebhookSecret();
      const graceEnd = await withBehaviorWriteLock(async () => {
        refuseSystem(await loadBehaviorRow(id));
        return behaviorTransaction(async (transaction) => {
          const action = await BehaviorWebhookAction.findByPk(id, { transaction });
          const current = (action?.getDataValue("secret") as string | null) ?? null;
          if (!action || current === null) {
            throw new BehaviorApiError(
              "validation_failed",
              "this behavior's webhook has no authentication; set webhook.authMode first",
              "webhook.authMode",
            );
          }
          const expiresAt = new Date(Date.now() + ROTATION_GRACE_MS);
          await action.update(
            {
              secret: encryptSecret(secret),
              previousSecret: current,
              previousSecretExpiresAt: expiresAt,
            },
            { transaction },
          );
          return expiresAt;
        });
      });

      await auditBehaviorWrite(request, "behavior.webhook_secret.rotate", `behavior:${id}`, {
        previousSecretExpiresAt: graceEnd.toISOString(),
      });
      return reply.send({ secret, previousSecretExpiresAt: graceEnd.toISOString() });
    },
  );
}
