/**
 * GET /api/auth/login-trigger (#146) — how to ask the bot for a login link,
 * for the admin login page before anyone is signed in: the System
 * Behavior's current trigger, as the text a user sends or types.
 *
 *   { trigger: { kind: "message", match: "startswith" | "endswith" | "regex", text } }
 *   { trigger: { kind: "command", text: "/<name>" } }
 *   { trigger: null }                       — no login trigger (should not happen)
 *
 * Nothing else: no ids, no visibility settings, no other behavior. The
 * trigger is not a secret — whoever sends it only gets a link when the
 * login action finds them authorised — and the page needs it precisely
 * when there is no session. Public, so it is mounted outside the
 * behavior scope (no behavior.manage gate) under /api/auth/, which the
 * web server's auth hook and write throttle skip; like the other
 * /api/auth/* endpoints it carries its own per-client rate limit. It
 * reads the in-memory catalog snapshot, so a flood never reaches the DB.
 */

import type { FastifyInstance } from "fastify";
import { RateLimiter } from "../../utils/rate-limiter.js";
import { recordAuthThrottled } from "../bot-events/auth-throttle-log.js";
import {
  AUTH_LOGIN_TRIGGER_PATH,
  refuseIfThrottled,
  type ClientThrottle,
} from "../web-core/client-throttle.js";
import { getBehaviorCatalog, systemLoginOf, type BehaviorCatalog } from "./behavior-catalog.js";
import type { BehaviorPatternKind } from "./models/behavior-definition.model.js";

export type LoginTriggerHint =
  | { kind: "message"; match: BehaviorPatternKind; text: string }
  | { kind: "command"; text: string };

/** The System Behavior's trigger, as the login page shows it. */
export function loginTriggerHint(catalog: BehaviorCatalog): LoginTriggerHint | null {
  const login = systemLoginOf(catalog);
  if (!login) return null;
  if (login.command) return { kind: "command", text: `/${login.command.name}` };
  const { patternKind, patternValue } = login.row;
  return patternKind && patternValue ? { kind: "message", match: patternKind, text: patternValue } : null;
}

// Per client, as generous as /api/auth/refresh: the page asks once per load.
const hintRateLimiter = new RateLimiter({ windowMs: 60_000, max: 60 });

export function registerLoginTriggerHintRoute(
  server: FastifyInstance,
  options: { limiter?: ClientThrottle } = {},
): void {
  const limiter = options.limiter ?? hintRateLimiter;
  server.get(AUTH_LOGIN_TRIGGER_PATH, async (request, reply) => {
    if (
      refuseIfThrottled(limiter, request, reply, {
        path: AUTH_LOGIN_TRIGGER_PATH,
        message: "Too many requests, slow down",
        onThrottled: recordAuthThrottled,
      })
    ) {
      return reply;
    }
    const trigger = loginTriggerHint(await getBehaviorCatalog());
    return reply.header("Cache-Control", "no-store").send({ trigger });
  });
}
