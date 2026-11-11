# Service login

Self-hosted services can log their users in through Karyl-chan. The
user sends the bot a DM (by default `!login-<audience>`), the bot answers
with a one-time link to the service, and the link carries a signed
**Service Token**: a JWT that says "this Discord user just logged in
through karyl, for you". The service verifies it against the bot's
public keys and starts its own session. No webhook receiver, no shared
secret.

This page is for the **service's author**: how to verify the token. Admins
set services up on the services page (below). The domain terms (Service,
Service Behavior, Service Token, JWKS) are defined in the bot's
[GLOSSARY.md](../../GLOSSARY.md#behaviors).

## Contents

- [Setting a service up](#setting-a-service-up)
- [What the service receives](#what-the-service-receives)
- [The token](#the-token)
- [Verifying the token](#verifying-the-token)
- [Example (Node.js)](#example-nodejs)
- [Keys and rotation](#keys-and-rotation)
- [Who may log in](#who-may-log-in)
- [Source](#source)

## Setting a service up

On the admin UI's **Services** page (`/admin/services`, **bot owners
only**: whoever sets a redirect URL receives the tokens of everyone who
logs in there), add a service:

| Field | What it is |
|-------|------------|
| Name | Shown in the login reply ("登入 *name*"). |
| Audience | The token's `aud`: a lower-case slug (`a-z`, `0-9`, `-`, at most 64), unique across services. Your service checks it. |
| Redirect URL | Where the link goes. Must be `https`, without credentials and without a `token` parameter of its own. |

Adding a service also adds its **Service Behavior**: a bot DM message
trigger on exactly `!login-<audience>`. It is listed on the behaviors page
under its section's *Services* group, where an owner can switch its
trigger — a bot DM pattern and who may use it, or a global command (its
reply is ephemeral) — and nothing else about it
([behaviors.md](behaviors.md#service-behaviors)). Deleting the service
deletes the trigger. Changing the audience moves a trigger that is still
on the default to the new name.

## What the service receives

The user opens

```
<redirect URL>?token=<service token>
```

(other query parameters of the redirect URL are kept). Handle it like
any login callback:

1. Read `token` from the query, then **redirect to a URL without it**
   right away, so it does not stay in the browser history, a `Referer`
   header or your access log.
2. [Verify](#verifying-the-token) it. Refuse the login on any failure.
3. Start your session for `sub`.

The link lives **120 seconds** and is meant to be used once.

## The token

A compact JWS, signed with Ed25519.

Header:

```json
{ "alg": "EdDSA", "typ": "karyl-service+jwt", "kid": "<RFC 7638 thumbprint of the signing key>" }
```

Claims:

| Claim | Value |
|-------|-------|
| `sub` | The user's Discord id (a snowflake, as a string). |
| `name` | Their display name (global name, else username). |
| `avatar` | Their avatar URL, or `null` when they have none. |
| `aud` | The service's audience. |
| `iss` | The bot's public base URL (`WEB_BASE_URL`, no trailing slash). |
| `jti` | A random id, unique per token. |
| `iat` | Issued at (seconds). |
| `exp` | `iat` + 120. |

## Verifying the token

Every check below is **required**. The bot's admin login tokens are
signed with the same key, so a signature check alone would let one of
those in: it is `typ` and `aud` that keep them out.

1. **Header.** `alg` is `EdDSA` and `typ` is `karyl-service+jwt`. A token
   without a `kid` is refused. Never take the algorithm from the token
   for anything but this comparison.
2. **Key.** Fetch the key set from `<iss>/.well-known/jwks.json` (cache
   it) and pick the key whose `kid` equals the token's. On an **unknown
   `kid`, fetch the set again** once — the bot may have rotated its key
   since you cached it — and refuse the token if the key is still not
   there. Do not fall back to "the only key in the set".
3. **Signature.** Verify the Ed25519 signature over
   `<header>.<payload>` with that key.
4. **`aud`** equals your service's audience exactly.
5. **`iss`** equals the bot's public base URL you configured — not a value
   taken from the token.
6. **`exp`** is in the future (allow a few seconds of clock skew at
   most).
7. **`jti` has not been used before.** Remember every `jti` you accept
   until its `exp` has passed, and refuse a token whose `jti` you have
   seen. **The bot does not track this — replay protection is the
   service's job.** A link forwarded or opened twice within its 120
   seconds is otherwise a second login.

Then the token is good: `sub` is who logged in. What they may do in your
service is your service's decision.

## Example (Node.js)

With [`jose`](https://github.com/panva/jose), whose remote key set
refetches on an unknown `kid` by itself:

```js
import { createRemoteJWKSet, jwtVerify } from "jose";

const KARYL = "https://karyl.example";   // the bot's public base URL (iss)
const AUDIENCE = "nas";                  // this service's audience
const jwks = createRemoteJWKSet(new URL(`${KARYL}/.well-known/jwks.json`));

// jti → exp (ms); use a shared store (Redis SET NX with a TTL, a DB
// table) when the service runs more than one process
const seen = new Map();

export async function verifyKarylToken(token) {
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ["EdDSA"],
    typ: "karyl-service+jwt",
    audience: AUDIENCE,
    issuer: KARYL,
    clockTolerance: 5,
    requiredClaims: ["sub", "jti", "exp"],
  });
  const now = Date.now();
  for (const [jti, exp] of seen) if (exp < now) seen.delete(jti);
  if (seen.has(payload.jti)) throw new Error("token already used");
  seen.set(payload.jti, payload.exp * 1000);
  return { id: payload.sub, name: payload.name, avatar: payload.avatar };
}
```

Any JOSE library that supports EdDSA (Ed25519) works the same way: check
`typ`, select the key by `kid` with a refetch on a miss, and pass the
expected `aud` and `iss` explicitly.

## Keys and rotation

`GET /.well-known/jwks.json` is public (rate-limited per client, 60 per
minute) and served as `application/jwk-set+json` with
`Cache-Control: public, max-age=60`. It lists the active signing key and
every key retired within the last 24 hours, so a token signed just before
an operator rotated the key still verifies. Each entry is an OKP key
(`crv: Ed25519`) with `kid`, `alg: EdDSA` and `use: sig`.

## Who may log in

Whoever can fire the service's trigger gets a link, so the trigger is the
access rule: on a DM pattern, its audience (everyone, one user, or an
Audience Group); on a command, whoever Discord shows it to (its installs
and contexts, and the server's integration settings). Service triggers
are checked before the admin login's, and the bot refuses a service
trigger that would take the login's own DMs (and a login trigger whose
pattern or sample a service trigger would take), or another service's,
so a service can never lock the owner out nor take another's users. A
user who triggers it too often is rate-limited like any trigger (5 per
10 seconds).

## Source

| File | Purpose |
|------|---------|
| `src/modules/behavior/models/service.model.ts` | The `services` table. |
| `src/modules/behavior/service-routes.ts` | `/api/services` (the services page). |
| `src/modules/behavior/service-behavior-rules.ts` | What a Service Behavior's trigger may be; the shadowing guards. |
| `src/modules/behavior/fixed-trigger-switch.ts` | The trigger switch it shares with the system login. |
| `src/modules/command-system/service-login-action.ts` | Mints the token and sends the link. |
| `src/modules/web-core/service-token.ts`, `jwt.service.ts`, `jwks-route.ts` | Signing and the key set. |
| `frontend/src/views/admin/services/` | The services page. |
