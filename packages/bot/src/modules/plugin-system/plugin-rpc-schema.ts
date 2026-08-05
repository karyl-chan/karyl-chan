/**
 * Declared request parsing for the plugin-facing RPC family.
 *
 * The RPC surface's problem is request parsing, not orchestration: the
 * overwhelming majority of the plugin system's hand-rolled `typeof`
 * checks live on this side, one per field per route. The remedy is a
 * framework feature — Fastify/ajv body schemas — rather than a new
 * module (see `docs/adr/0002-plugin-admin-actor-line.md`, last bullet).
 *
 * This module is the part that has to be got right once, because every
 * scope family converted afterwards inherits it:
 *
 *   - `formatPluginRpcSchemaError` turns ajv's error list into a single
 *     message that names the offending field;
 *   - `installPluginRpcSchemaErrors` wires that formatter plus the error
 *     handler that renders it in the RPC family's historical body shape;
 *   - `STRICT_RPC_AJV_OPTIONS` switches ajv's type coercion off so a
 *     schema refuses exactly what the hand-rolled check refused.
 */

import type {
  FastifyError,
  FastifyInstance,
  FastifySchemaValidationError,
} from "fastify";

/** Discord snowflake, as the hand-rolled checks spelled it. */
export const SNOWFLAKE_PATTERN = "^[0-9]{17,20}$";

/**
 * Ajv options for the whole server, passed to the Fastify factory.
 *
 * Only `coerceTypes` is overridden, and it is not cosmetic: Fastify's
 * ajv default is `coerceTypes: 'array'`, which would quietly accept
 * `{"channel_id": 12345}` by rewriting it to `"12345"` — a request the
 * hand-rolled `typeof body.channel_id !== "string"` check rejected with
 * a 400. Adopting schemas under the default would therefore *widen* the
 * accepted request shape on every converted route, silently. Turning
 * coercion off makes a body schema mean what the check meant.
 *
 * This lives at the factory because Fastify takes ajv options there
 * only; it is harmless to routes without schemas, which is every route
 * outside this family today.
 */
export const STRICT_RPC_AJV_OPTIONS = { coerceTypes: false } as const;

/** `/attachments/0/name` → `attachments.0.name`; `""` → `""`. */
function pathToField(instancePath: string): string {
  return instancePath.replace(/^\//, "").replace(/\//g, ".");
}

/** The dotted name of the field an ajv error is about, `""` if it is
 *  about the body as a whole. */
function fieldOf(err: FastifySchemaValidationError): string {
  const base = pathToField(err.instancePath);
  if (err.keyword === "required") {
    const missing = String(err.params.missingProperty ?? "");
    return base ? `${base}.${missing}` : missing;
  }
  return base;
}

function describe(
  err: FastifySchemaValidationError,
  dataVar: string,
): string {
  const field = fieldOf(err);
  if (err.keyword === "required") return `${field} required`;
  // Ajv renders a pattern failure as `must match pattern "^[0-9]{17,20}$"`,
  // which tells a plugin author nothing. The only pattern this family
  // uses is the snowflake one, so name it.
  if (err.keyword === "pattern" && err.params.pattern === SNOWFLAKE_PATTERN) {
    return `${field} must be a Discord id`;
  }
  const message = err.message ?? "is invalid";
  // instancePath is empty when the failure is about the body itself
  // (e.g. no body at all → "body must be object").
  return field ? `${field} ${message}` : `${dataVar} ${message}`;
}

/**
 * Collapse ajv's error list into one human message.
 *
 * The list is ordered and the first entry is the complaint to report.
 * `allErrors` deliberately stays off (the ajv compiler's own comment
 * calls it a DoS vector), so ajv stops at the first failing keyword and
 * the list is short by construction.
 */
export function formatPluginRpcSchemaError(
  errors: FastifySchemaValidationError[],
  dataVar: string,
): Error {
  const first = errors[0];
  if (!first) return new Error(`${dataVar} is invalid`);
  return new Error(describe(first, dataVar));
}

/**
 * Install the schema error formatter and the matching error handler on
 * `server` — a Fastify scope holding the plugin RPC routes and nothing
 * else, so neither setting reaches the admin route family.
 *
 * ## Why the body shape is preserved
 *
 * Nothing forces it. The SDK classifies an RPC failure by HTTP status
 * (`classifyHttpStatus` in `packages/plugin-sdk/src/server.ts`) and
 * never parses the response body — it embeds the raw text, truncated,
 * into the thrown `BotRpcError`'s message. The SDK contract fixtures'
 * `rpc` block pins only `pathsCalledBySdk`, not an error shape. A
 * Fastify default validation body (`{statusCode, error, message}`)
 * would therefore not break any plugin we ship.
 *
 * We keep `{ error: "<message>" }` anyway because this is a refactor.
 * Reshaping a response that some operator's tooling may read is a
 * behaviour change, and making it route by route would mean arguing
 * "nobody depends on this" once per converted route instead of writing
 * one formatter here. The formatter is the cheaper end of that trade,
 * and it is set once for every family that follows.
 */
export function installPluginRpcSchemaErrors(server: FastifyInstance): void {
  server.setSchemaErrorFormatter(formatPluginRpcSchemaError);
  server.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.validation) {
      // Fastify has already stamped statusCode 400 on a validation
      // failure; read it rather than hard-coding, so a schema that
      // sets its own status keeps it.
      reply.code(error.statusCode ?? 400).send({ error: error.message });
      return;
    }
    // Everything that is not a schema failure goes back to Fastify's
    // default handling: re-sending the error from inside an error
    // handler hands it to the next handler in the chain, which for
    // this scope is the framework default.
    reply.send(error);
  });
}
