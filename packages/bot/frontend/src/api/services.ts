import { authedFetch, jsonOrThrow } from "./client";

// Mirrors packages/bot/src/modules/behavior/service-routes.ts (#126): the
// services page's API. A service is a self-hosted app that logs its users
// in through karyl; each one owns a Service Behavior (its trigger, edited
// on the behaviors page). Refusals use the behavior API's codes
// (validation_failed, name_conflict, not_found) with the offending `field`.

export interface ServiceInput {
  name: string;
  /** The token's `aud`: a lower-case slug, unique. */
  audience: string;
  /** Where the login link goes (https); the bot adds `?token=`. */
  redirectUrl: string;
}

export interface ServiceView extends ServiceInput {
  id: number;
  /** Its Service Behavior on the behaviors page. */
  behaviorId: number | null;
  trigger: {
    patternKind: string | null;
    patternValue: string | null;
    audienceKind: string;
  } | null;
  createdAt: string;
  /** Send back as `ifUpdatedAt` to refuse a stale edit. */
  updatedAt: string;
}

export type ServicePatch = Partial<ServiceInput> & { ifUpdatedAt?: string };

/** Lower-case slug, as the server checks it (SERVICE_AUDIENCE_PATTERN). */
export const SERVICE_AUDIENCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return authedFetch(path, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
}

export async function listServices(): Promise<ServiceView[]> {
  const { services } = await jsonOrThrow<{ services: ServiceView[] }>(await authedFetch("/api/services"));
  return services;
}

export async function createService(input: ServiceInput): Promise<ServiceView> {
  const { service } = await jsonOrThrow<{ service: ServiceView }>(await send("POST", "/api/services", input));
  return service;
}

export async function updateService(id: number, patch: ServicePatch): Promise<ServiceView> {
  const { service } = await jsonOrThrow<{ service: ServiceView }>(await send("PUT", `/api/services/${id}`, patch));
  return service;
}

export async function deleteService(id: number): Promise<void> {
  const r = await send("DELETE", `/api/services/${id}`);
  if (!r.ok) await jsonOrThrow(r);
}
