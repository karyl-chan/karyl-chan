/**
 * Authed fetch wrapper for plugin SPAs.
 *
 * Behaviour:
 *  - Sends `Authorization: Bearer <token>` when the auth state has one.
 *  - On 401/403: clears the auth state, fires the `onAccessDenied`
 *    handler, and rejects. (Caller routes to a "denied" view.)
 *  - In manage mode: on a 401 the wrapper attempts ONE silent
 *    `tryRefresh` before surfacing the error.
 *  - 204 responses resolve to `{}` (callers can still type the result as
 *    Record<string, never>).
 *  - Non-2xx with a JSON `{error}` body rejects with the message; non-2xx
 *    without a recognisable body rejects with "Request failed".
 */

import type { AuthState } from "./auth";

export interface PluginApi {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  upload<T = unknown>(
    path: string,
    file: File,
    fields?: Record<string, string>,
  ): Promise<T>;
}

export interface PluginApiOptions {
  /** Plugin's HTTP origin + base path (see `./plugin-base` `API_BASE`). */
  apiBase: string;
  /** Backing auth state (created by `createAuthState`). */
  auth: AuthState;
}

async function handleResponse<T>(
  res: Response,
  auth: AuthState,
): Promise<T> {
  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({ error: "Access denied" }));
    const msg =
      (body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : null) ?? "Access denied";
    auth.clear();
    auth._emitDenied(msg);
    throw new Error(msg);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    const msg =
      (body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : null) ?? "Request failed";
    throw new Error(msg);
  }
  if (res.status === 204) return {} as T;
  return (res.json().catch(() => ({}))) as Promise<T>;
}

export function createPluginApi(opts: PluginApiOptions): PluginApi {
  const { apiBase, auth } = opts;

  function buildInit(method: string, body: unknown | undefined): RequestInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.bearerToken() ?? ""}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return init;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res = await fetch(apiBase + path, buildInit(method, body));
    if (
      res.status === 401 &&
      auth.getMode() === "manage" &&
      (await auth.tryRefresh(apiBase))
    ) {
      res = await fetch(apiBase + path, buildInit(method, body));
    }
    return handleResponse<T>(res, auth);
  }

  async function upload<T>(
    path: string,
    file: File,
    fields?: Record<string, string>,
  ): Promise<T> {
    const send = (): Promise<Response> => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      for (const [k, v] of Object.entries(fields ?? {})) fd.append(k, v);
      return fetch(apiBase + path, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.bearerToken() ?? ""}` },
        body: fd,
      });
    };
    let res = await send();
    if (
      res.status === 401 &&
      auth.getMode() === "manage" &&
      (await auth.tryRefresh(apiBase))
    ) {
      res = await send();
    }
    return handleResponse<T>(res, auth);
  }

  return { request, upload };
}
