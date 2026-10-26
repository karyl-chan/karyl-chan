/**
 * The behavior API's refusal contract (#136, #95).
 *
 * Every refusal a behavior route makes — a schema failure, a Discord rule,
 * a name conflict, a failed registration — has one body:
 *
 *   { error: { code, message, field? } }
 *
 * `code` is drawn from a closed set so the admin UI can translate it;
 * `message` is the readable reason; `field` is the dotted path of the
 * offending request field when there is one (`leaves.0.options.1.name`).
 *
 * Request schemas are validated by this module's own ajv instance, not
 * Fastify's default: the default runs with `removeAdditional: true`, which
 * would quietly DROP an unknown property where `additionalProperties:
 * false` is meant to refuse it — the silently-accepted input #95 is about.
 * Coercion is off for the same reason (`"1"` is not a boolean).
 *
 * Auth refusals (401 / 403 from the capability gate) keep their own shape:
 * they resolve before a behavior route is reached.
 */

import { Ajv, type ErrorObject } from "ajv";
import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import { ValidationError as SequelizeValidationError } from "sequelize";

export type BehaviorErrorCode =
  | "validation_failed"
  | "name_conflict"
  | "system_immutable"
  | "registration_failed"
  | "not_found"
  | "invalid_tree";

const STATUS: Record<BehaviorErrorCode, number> = {
  validation_failed: 400,
  not_found: 404,
  name_conflict: 409,
  invalid_tree: 409,
  system_immutable: 409,
  // Discord (the upstream) refused or could not be reached
  registration_failed: 502,
};

export interface BehaviorErrorBody {
  error: {
    code: BehaviorErrorCode;
    message: string;
    field?: string;
    /** registration_failed only: what each registration target reported */
    details?: unknown;
  };
}

/** A refusal thrown from a behavior route; the scope's error handler renders it. */
export class BehaviorApiError extends Error {
  constructor(
    readonly code: BehaviorErrorCode,
    message: string,
    readonly field?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BehaviorApiError";
  }

  get statusCode(): number {
    return STATUS[this.code];
  }

  toBody(): BehaviorErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field !== undefined ? { field: this.field } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export function sendBehaviorError(reply: FastifyReply, err: BehaviorApiError): FastifyReply {
  return reply.code(err.statusCode).send(err.toBody());
}

// ── schema errors ────────────────────────────────────────────────────────────

/** Patterns the messages name instead of quoting the regex. */
export const SNOWFLAKE_PATTERN = "^\\d{17,20}$";
export const ROW_ID_PATTERN = "^[1-9]\\d{0,9}$";

function fieldOf(err: ErrorObject): string | undefined {
  const base = err.instancePath.replace(/^\//, "").replace(/\//g, ".");
  const join = (child: string) => (base ? `${base}.${child}` : child);
  if (err.keyword === "required") {
    return join(String(err.params["missingProperty"] ?? ""));
  }
  if (err.keyword === "additionalProperties") {
    return join(String(err.params["additionalProperty"] ?? ""));
  }
  return base || undefined;
}

function describe(err: ErrorObject, field: string | undefined): string {
  const subject = field ?? "request body";
  switch (err.keyword) {
    case "required":
      return `${subject} is required`;
    case "additionalProperties":
      return `${subject} is not a known field`;
    case "pattern":
      if (err.params["pattern"] === SNOWFLAKE_PATTERN) {
        return `${subject} must be a Discord id (17–20 digits)`;
      }
      if (err.params["pattern"] === ROW_ID_PATTERN) {
        return `${subject} must be a positive integer id`;
      }
      return `${subject} has an invalid format`;
    default:
      return `${subject} ${err.message ?? "is invalid"}`;
  }
}

/** The first ajv error → `validation_failed` (ajv stops at the first one). */
function schemaRefusal(errors: readonly ErrorObject[]): BehaviorApiError {
  const first = errors[0];
  if (!first) return new BehaviorApiError("validation_failed", "request is invalid");
  const field = fieldOf(first);
  return new BehaviorApiError("validation_failed", describe(first, field), field);
}

// ── scope installer ──────────────────────────────────────────────────────────

const ajv = new Ajv({
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  allErrors: false,
});

/**
 * Install the behavior routes' validator and error handler on `scope` —
 * an encapsulated Fastify scope holding the behavior routes and nothing
 * else, so neither setting reaches another route family.
 */
export function installBehaviorRouteValidation(scope: FastifyInstance): void {
  scope.setValidatorCompiler(({ schema }) => ajv.compile(schema as object));
  scope.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof BehaviorApiError) {
      return sendBehaviorError(reply, error);
    }
    if (error.validation) {
      return sendBehaviorError(
        reply,
        schemaRefusal(error.validation as unknown as ErrorObject[]),
      );
    }
    // A model validator caught what the route checks should have — still
    // the caller's input, not a server fault.
    if (error instanceof SequelizeValidationError) {
      return sendBehaviorError(
        reply,
        new BehaviorApiError(
          "validation_failed",
          error.errors[0]?.message ?? error.message,
          error.errors[0]?.path ?? undefined,
        ),
      );
    }
    // Framework-level request refusals (unparseable JSON, unsupported
    // content type, body too large): the request is at fault, keep the
    // status Fastify chose.
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply
        .code(status)
        .send(new BehaviorApiError("validation_failed", error.message).toBody());
    }
    return reply.send(error);
  });
}
