import { jwtService, type JwtService } from "./jwt.service.js";
import { publicBaseUrl } from "./public-base-url.js";

/**
 * Service token issuance (#126): the token a self-hosted service receives
 * when a user logs in to it through karyl. The service verifies it against
 * `/.well-known/jwks.json` — signature by `kid`, then `aud`, `iss`, `exp`,
 * and refuses a `jti` it has seen before (karyl does not track them).
 */

/** The user the token vouches for. */
export interface ServiceTokenUser {
  /** Discord user id → `sub`. */
  id: string;
  /** Display name → `name`. */
  name: string;
  /** Avatar URL → `avatar`; null when the user has none. */
  avatar: string | null;
}

export function mintServiceToken(
  user: ServiceTokenUser,
  audience: string,
  options: { now?: number; signer?: JwtService } = {},
): { token: string; jti: string; expiresAt: number } {
  const signer = options.signer ?? jwtService;
  return signer.signService(
    {
      sub: user.id,
      name: user.name,
      avatar: user.avatar,
      aud: audience,
      iss: publicBaseUrl(),
    },
    { now: options.now },
  );
}
