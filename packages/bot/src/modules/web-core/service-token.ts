import { jwtService, type SignedServiceToken } from "./jwt.service.js";
import { publicBaseUrl } from "./public-base-url.js";

/**
 * Service token issuance (#126): the token a self-hosted service receives
 * when a user logs in to it through karyl. The service verifies it against
 * `/.well-known/jwks.json` — header `typ: karyl-service+jwt`, signature by
 * `kid`, then `aud`, `iss`, `exp` — and refuses a `jti` it has seen before
 * (karyl does not track them).
 */

/** Mint a token saying the Discord user `userId` logged in to `audience`. */
export function mintServiceToken(
  userId: string,
  audience: string,
  options: { now?: number } = {},
): SignedServiceToken {
  return jwtService.signService(
    { sub: userId, aud: audience, iss: publicBaseUrl() },
    { now: options.now },
  );
}

/** The redirect URL with the token as its `token` parameter. */
export function serviceLoginLink(redirectUrl: string, token: string): string {
  const url = new URL(redirectUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Discord's cap on a link button's URL: a login link longer than this cannot be sent. */
export const LOGIN_LINK_MAX_LENGTH = 512;

/** A Discord id is a 64-bit integer: at most 20 digits. */
const LONGEST_USER_ID = "9".repeat(20);

/**
 * The longest login link a service with this redirect URL and audience can
 * get. Everything else in the token has a fixed length.
 */
export function longestServiceLoginLink(redirectUrl: string, audience: string): number {
  return serviceLoginLink(redirectUrl, mintServiceToken(LONGEST_USER_ID, audience).token).length;
}
