import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyReplyFrom from "@fastify/reply-from";
import { findPluginByKey } from "./models/plugin.model.js";
import { getCachedPluginByKey } from "./plugin-lookup-cache.js";
import {
  assertPluginTarget,
  HostPolicyError,
} from "../../utils/host-policy.js";
import { getServiceDiscovery } from "../../adapters/registry.js";

/** Regex that matches valid pluginKey values (same constraint as plugin.id at register time). */
const PLUGIN_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Transient upstream connection-error codes that are safe to retry once
 * during a plugin-container recreate window. Kept byte-for-byte in sync
 * with `isConnectRefused()` in plugin-dispatch-pool.ts so the event-dispatch
 * path and the HTTP reverse-proxy path treat the recreate race identically.
 *
 * These are all pre-send / connection-phase failures: the upstream socket
 * was never successfully established, so nothing was delivered to the plugin
 * and a replay cannot double-submit.
 */
const TRANSIENT_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED", // container gone, port not yet bound (the recreate race)
  "ENOTFOUND", // DNS not yet resolvable (compose recreate re-registers the name)
  "EAI_AGAIN", // transient DNS failure
  "ETIMEDOUT", // connect timed out
  "UND_ERR_CONNECT_TIMEOUT", // undici connect-phase timeout
]);

/**
 * One-shot retry window for a transient upstream connection failure during a
 * plugin recreate. Mirrors plugin-dispatch-pool.ts: a single retry after a
 * short delay turns the [[bot-plugin-proxy-recreate-race]] 502 into a
 * slightly-delayed success while a genuinely-down plugin still fails fast.
 */
const PROXY_CONNECT_RETRY_COUNT = 1;
const PROXY_CONNECT_RETRY_DELAY_MS = 250;

/**
 * Per-pluginKey round-robin cursor for spreading proxy traffic across
 * the live endpoints service discovery returns (PR-3.2). With the
 * single-replica default discovery returns one endpoint, so the cursor
 * never advances and the same url is always chosen — current behaviour.
 */
const rrCursor = new Map<string, number>();

function pickEndpoint(pluginKey: string, endpoints: string[]): string {
  if (endpoints.length <= 1) return endpoints[0];
  const i = (rrCursor.get(pluginKey) ?? 0) % endpoints.length;
  rrCursor.set(pluginKey, i + 1);
  return endpoints[i];
}

/**
 * Register the `/plugin/<pluginKey>/*` reverse proxy.
 *
 * Design decisions:
 *
 * Upstream resolution: per-request, using `findPluginByKey` against the DB.
 * The plugin row must exist and `status === 'active'`. The `enabled` flag is
 * intentionally ignored here — `enabled` gates Discord command/event dispatch,
 * NOT the plugin's own HTTP surface; an admin may want to view a disabled
 * plugin's WebUI without re-enabling its Discord commands.
 *
 * Auth: /plugin/* is intentionally NOT behind the bot's admin auth hook.
 * The plugin does its own `plugin-session` JWT check; the Discord `?token=`
 * link lands here without a bot login session and must reach the plugin
 * server as-is. The global onRequest hook in server.ts only gates `/api/*`,
 * so /plugin/* is already unguarded at the hook level.
 *
 * Proxy approach: hand-rolled `server.all` + `@fastify/reply-from`. The
 * `@fastify/http-proxy` `getUpstream` option would be cleaner but requires
 * the upstream to be deterministic at plugin-register time. Here we need a
 * per-request async DB lookup, which `reply.from()` supports naturally when
 * called manually inside a route handler.
 *
 * Helmet / CSP: @fastify/helmet is wrapped with fastify-plugin so its
 * onRequest hooks propagate to the entire root scope, including /plugin/*.
 * Helmet's security headers (including Content-Security-Policy) ARE applied
 * to every /plugin/* response. However, @fastify/reply-from copies the
 * upstream response headers (including any CSP the upstream sends) back to
 * the client — when the upstream sends a CSP header it overwrites helmet's.
 * Plugin WebUIs MUST therefore send their own Content-Security-Policy; a
 * plugin that sends no CSP will be served with the bot's strict default CSP,
 * which will block most inline scripts and styles.
 *
 * Body / multipart: the proxy is registered inside an encapsulated scope
 * (see server.ts — `server.register(async (instance) => { registerPluginProxy(instance) })`).
 * A catch-all content-type parser (`'*'`) is registered on that encapsulated
 * instance, so the globally-registered @fastify/multipart parser (which
 * consumes multipart/form-data bodies and would otherwise empty them before
 * the proxy could forward them) is overridden within the proxy scope only.
 * Bodies are buffered as Buffer before forwarding — safe for the proxy's
 * upload payloads (radio cover-art is <=25 MiB, already enforced by the
 * bodyLimit Fastify option). The root scope's @fastify/multipart is
 * unaffected and continues to parse multipart bodies for /api/* routes.
 *
 * SSRF: the upstream URL is re-vetted via `assertPluginTarget()` on every
 * proxied request, mirroring the per-call pattern used in
 * plugin-interaction-dispatch.service.ts and plugin-event-bridge.service.ts.
 * This prevents a plugin operator from repointing the plugin's DNS after
 * registration to redirect the anonymous-accessible proxy to an internal
 * target. On policy violation the proxy returns 502 and does not connect.
 *
 * Header hygiene: hop-by-hop and sensitive forwarding headers are stripped
 * and replaced with canonical values before the request is forwarded. Any
 * set-cookie headers in the upstream response have their Path rewritten to
 * the plugin's proxy prefix and their Domain attribute stripped, so a plugin
 * cannot set cookies on the bot's root domain.
 *
 * SSE / WebSocket: long-lived text/event-stream responses will hit the
 * 30-second upstream timeout and be dropped. WebSocket Upgrade requests are
 * not proxied by @fastify/reply-from — a future plugin needing real-time
 * transport would require the proxy to be extended.
 *
 * Recreate-race retry: when a plugin container is recreated
 * (`docker compose up --build -d <plugin>`), there is a short window where
 * the old container is gone and the new one has not yet bound its port. A
 * request forwarded during that window fails with ECONNREFUSED (or a
 * transient DNS / connect-timeout error). The event-dispatch path already
 * mitigates the same window with a one-shot ECONNREFUSED retry
 * (plugin-dispatch-pool.ts); this proxy mirrors that with a single
 * `PROXY_CONNECT_RETRY_DELAY_MS` retry, driven by @fastify/reply-from's
 * `retryDelay` hook. See `proxyConnectRetryDelay` below for the safety
 * scope (replay-safe, body-less requests only).
 */
/**
 * Extract a connection-error code from whatever @fastify/reply-from surfaces
 * in the `retryDelay` details. The underlying undici error carries `.code`;
 * some wrapped errors expose the original on `.cause`.
 */
function transientConnectCode(err: unknown): string | undefined {
  // undici surfaces the code on `.code`; some wrappers expose the original
  // on `.cause.code`. Check both, then match against the transient set.
  const e = err as { code?: string; cause?: { code?: string } } | null | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && TRANSIENT_CONNECT_ERROR_CODES.has(code)
    ? code
    : undefined;
}

/**
 * `retryDelay` hook for @fastify/reply-from. Returns the delay (ms) before
 * a single retry, or `null` to give up (which lets `onError` send the 502).
 *
 * Body-replay safety: we retry ONLY when the forwarded request carries no
 * body (`content-length` absent or "0"). A buffered request body would have
 * to be re-sent on retry, and for a non-idempotent upstream that risks a
 * double-submit. The connection phase of these refused requests never
 * reached the plugin, so a body-less replay is safe; a request that DID
 * carry a body is left to fail fast (the client can retry the whole
 * operation itself). This mirrors @fastify/reply-from's own built-in
 * `getDefaultDelay`, which also guards on `!contentLength`.
 *
 * The retry is bounded to a single attempt (`attempt` counts retries so far,
 * 0-based) after `PROXY_CONNECT_RETRY_DELAY_MS`, so a genuinely-down plugin
 * still fails fast instead of hanging the user.
 */
function proxyConnectRetryDelay(
  details: { err: Error; attempt: number },
  hasRequestBody: boolean,
  log: { warn: (obj: unknown, msg: string) => void },
  pluginKey: string,
): number | null {
  if (hasRequestBody) return null;
  if (details.attempt >= PROXY_CONNECT_RETRY_COUNT) return null;
  const code = transientConnectCode(details.err);
  if (!code) return null;
  log.warn(
    { code, pluginKey, attempt: details.attempt },
    "plugin proxy upstream connect failed; retrying once (recreate race)",
  );
  return PROXY_CONNECT_RETRY_DELAY_MS;
}

export async function registerPluginProxy(
  server: FastifyInstance,
): Promise<void> {
  // Override any globally-registered content-type parser (including the
  // @fastify/multipart parser registered at the root scope) within this
  // encapsulated instance. Buffer the body so @fastify/reply-from can
  // forward it intact, regardless of Content-Type.
  server.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (
      _req: FastifyRequest,
      payload: Buffer,
      done: (err: null, body: Buffer) => void,
    ) => {
      done(null, payload);
    },
  );

  // Register @fastify/reply-from without a base URL so that `reply.from()`
  // accepts fully-qualified upstream URLs constructed per-request.
  await server.register(fastifyReplyFrom, {
    disableRequestLogging: true,
  });

  // Redirect bare /plugin/:pluginKey (no trailing slash) to /plugin/:pluginKey/
  // so the plugin WebUI always loads under a canonical prefix.
  server.get<{ Params: { pluginKey: string } }>(
    "/plugin/:pluginKey",
    async (request, reply) => {
      const { pluginKey } = request.params;
      // Reject invalid key format immediately — prevents CRLF/odd chars from
      // reaching the Location header.
      if (!PLUGIN_KEY_RE.test(pluginKey)) {
        reply.code(404).send({ error: "unknown plugin" });
        return;
      }
      // Take the raw suffix from request.raw.url to preserve the original
      // query string exactly as received (no double-decoding).
      const prefix = "/plugin/" + pluginKey;
      const rest = (request.raw.url ?? "").slice(prefix.length); // "?tab=queue" or ""
      const qs = rest.startsWith("?") ? rest : "";
      reply.redirect(`/plugin/${pluginKey}/${qs}`, 301);
    },
  );

  // Proxy all methods on /plugin/:pluginKey/* to the plugin's stored URL,
  // stripping the /plugin/:pluginKey prefix from the forwarded path.
  //
  // Example: GET /plugin/karyl-radio/dashboard?tab=queue
  //  => plugin.url = "http://karyl-radio-plugin:3000"
  //  => forwards to http://karyl-radio-plugin:3000/dashboard?tab=queue
  server.all<{ Params: { pluginKey: string; "*": string } }>(
    "/plugin/:pluginKey/*",
    async (request, reply) => {
      const { pluginKey } = request.params;

      // Reject invalid key format immediately — prevents CRLF/odd chars from
      // reaching the DB lookup or any downstream header.
      if (!PLUGIN_KEY_RE.test(pluginKey)) {
        reply.code(404).send({ error: "unknown plugin" });
        return;
      }

      // 30s TTL cache + lifecycle-event invalidation. Plugin proxy is
      // the hottest read path on the plugins table — WebUI traffic +
      // plugin → bot RPC authz both flow through here. The cache
      // short-circuits everything except the first request per plugin
      // per 30s window.
      const plugin = await getCachedPluginByKey(pluginKey, findPluginByKey);
      if (!plugin || plugin.status !== "active") {
        reply.code(404).send({ error: "unknown plugin" });
        return;
      }

      // Resolve the plugin's live endpoint(s) via service discovery
      // (PR-3.2). In-process default returns just the DB row's url; a
      // DNS/k8s impl returns one base url per ready replica. We pick one
      // (round-robin) so multi-replica plugins are load-distributed.
      let chosenBase: string;
      try {
        const endpoints = await getServiceDiscovery().resolve(
          pluginKey,
          plugin.url,
        );
        chosenBase = pickEndpoint(pluginKey, endpoints);
      } catch (err) {
        (reply.log ?? server.log).warn(
          { err, pluginKey },
          "plugin proxy service discovery failed",
        );
        reply.code(502).send({ error: "plugin unreachable" });
        return;
      }

      // Re-vet the chosen upstream URL on every request. `plugin.url` may
      // have been valid at register time, but a plugin operator who
      // repoints DNS afterwards could redirect the anonymous-accessible
      // proxy to an internal target. This mirrors the per-call pattern in
      // plugin-interaction-dispatch.service.ts and plugin-event-bridge.service.ts.
      // The check runs on the resolved endpoint (an IP under DNS-SD), so
      // host-policy still vets the concrete address being connected to.
      const parsedUrl = new URL(chosenBase);
      const upstreamPort = parsedUrl.port
        ? Number(parsedUrl.port)
        : parsedUrl.protocol === "https:"
          ? 443
          : 80;
      try {
        await assertPluginTarget(parsedUrl.hostname, upstreamPort);
      } catch (err) {
        if (err instanceof HostPolicyError) {
          reply.code(502).send({ error: "plugin target not allowed" });
          return;
        }
        throw err;
      }

      // Take the raw suffix directly from the raw request URL so that
      // percent-encoded characters and query strings are preserved exactly
      // as received — request.params["*"] is already URL-decoded by
      // find-my-way and would cause double-decode issues for paths containing
      // '%' or encoded '?'.
      const prefix = "/plugin/" + pluginKey;
      const rest = (request.raw.url ?? "/").slice(prefix.length) || "/";
      // rest starts with '/' and includes the undecoded path + query string.

      const target = chosenBase.replace(/\/+$/, "") + rest;

      // Only retry the recreate-race window for requests that carry no body —
      // re-sending a buffered body to a non-idempotent upstream risks a
      // double-submit. See `proxyConnectRetryDelay`.
      const cl = request.headers["content-length"];
      const hasRequestBody =
        typeof cl === "string" && cl.length > 0 && cl !== "0";

      return reply.from(target, {
        timeout: 30_000,

        // Bound the recreate-race retry to a single attempt. The actual
        // gating (transient connect codes + body-replay safety + delay)
        // lives in `proxyConnectRetryDelay`; without a non-zero retriesCount
        // the library's built-in default-delay path never fires for our
        // undici transport (it only auto-retries UND_ERR_SOCKET).
        retriesCount: PROXY_CONNECT_RETRY_COUNT,
        retryDelay: (details) =>
          proxyConnectRetryDelay(
            details,
            hasRequestBody,
            reply.log ?? server.log,
            pluginKey,
          ),

        rewriteRequestHeaders(_originalReq, headers) {
          // Strip hop-by-hop and trust-sensitive forwarding headers so a
          // downstream plugin cannot spoof the bot's forwarding chain or
          // observe session cookies from the bot's domain.
          delete headers["x-forwarded-for"];
          delete headers["x-forwarded-host"];
          delete headers["x-forwarded-proto"];
          delete headers["forwarded"];
          delete headers["x-real-ip"];
          delete headers["cookie"];
          // @fastify/reply-from hands us a content-type with media-type
          // parameters stripped (e.g. "multipart/form-data" without the
          // ; boundary=... part). Plugins that parse multipart uploads
          // (fastify-multipart's request.file()) need the boundary, so
          // restore the original header verbatim before forwarding.
          const originalCt = request.headers["content-type"];
          if (typeof originalCt === "string" && originalCt.length > 0) {
            headers["content-type"] = originalCt;
          }
          // Set canonical forwarding headers for the upstream. Authorization
          // is kept — a plugin may use it for its own API.
          headers["x-forwarded-for"] = request.ip;
          headers["x-forwarded-proto"] = request.protocol;
          headers["x-forwarded-host"] = request.headers.host ?? "";
          return headers;
        },

        rewriteHeaders(headers) {
          // Rewrite set-cookie headers from the upstream so a plugin cannot
          // set cookies on the bot's root domain. Path is scoped to the
          // plugin's proxy prefix; Domain attribute is stripped entirely.
          const setCookie = headers["set-cookie"];
          if (setCookie) {
            const rewrite = (c: string) =>
              c
                // Remove any existing Path= attribute.
                .replace(/;\s*Path=[^;]*/gi, "")
                // Strip Domain= so the cookie is scoped to the current host only.
                .replace(/;\s*Domain=[^;]*/gi, "") +
              `; Path=/plugin/${pluginKey}/`;
            const rawValues = Array.isArray(setCookie)
              ? setCookie
              : [setCookie as string];
            headers["set-cookie"] = rawValues.map(rewrite);
          }
          return headers;
        },

        onError(reply, { error }) {
          (reply.log ?? server.log).warn(
            { err: error, pluginKey },
            "plugin proxy upstream error",
          );
          reply.code(502).send({ error: "plugin unreachable" });
        },
      });
    },
  );
}
