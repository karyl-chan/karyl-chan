/**
 * FileSecretProvider — external SecretProvider impl backed by files on a
 * mounted directory (PR-5.1).
 *
 * This is the concrete "external" provider and deliberately the
 * lowest-common-denominator one, because the two most common production
 * secret backends surface secrets *as files*:
 *
 *   • Kubernetes Secret mounted as a volume → one file per key under a
 *     directory (e.g. /var/run/secrets/karyl/VOICE_HMAC_SECRET).
 *   • Vault Agent / CSI driver templating → same shape: rendered files on
 *     a tmpfs the app reads.
 *
 * Selected by `SECRET_PROVIDER=file`; the mount root comes from
 * `SECRET_DIR` (default `/var/run/secrets/karyl`). For each logical
 * secret `NAME` the provider reads `${SECRET_DIR}/NAME`, and for the
 * rotation window `${SECRET_DIR}/NAME.previous`. Files are re-read with a
 * short TTL so a rotated mount (k8s updates the projected files in place;
 * Vault Agent rewrites them) is picked up without a restart — which is the
 * whole point of central rotation.
 *
 * Falls back to the env var when a file is absent, so a partial migration
 * (some secrets in files, some still in env) works.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  type SecretProvider,
  type SecretName,
  type RotatableSecret,
  ENV_VAR as ENV_FALLBACK,
} from "./secret-provider.js";

const DEFAULT_SECRET_DIR = "/var/run/secrets/karyl";

/** Re-read window. Short enough to pick up a rotated mount promptly,
 *  long enough to avoid a filesystem stat on every single request. */
const FILE_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  value: string | null;
  readAtMs: number;
}

export interface FileSecretProviderOptions {
  /** Mount root. Defaults to `SECRET_DIR` env or `/var/run/secrets/karyl`. */
  dir?: string;
  /** Cache TTL in ms. Defaults to 5000. Set 0 to disable caching (tests). */
  ttlMs?: number;
  /** Injectable reader + clock for tests. */
  readFile?: (path: string) => string;
  now?: () => number;
}

export class FileSecretProvider implements SecretProvider {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly readFile: (path: string) => string;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: FileSecretProviderOptions = {}) {
    this.dir =
      opts.dir ??
      (process.env.SECRET_DIR?.trim() || DEFAULT_SECRET_DIR);
    this.ttlMs = opts.ttlMs ?? FILE_CACHE_TTL_MS;
    this.readFile =
      opts.readFile ?? ((p) => readFileSync(p, "utf8"));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Read a single file (relative name under the mount), trimmed. `null`
   *  when the file is missing/empty. Cached for `ttlMs`. */
  private readKeyFile(fileName: string): string | null {
    const now = this.now();
    const cached = this.cache.get(fileName);
    if (cached && now - cached.readAtMs < this.ttlMs) {
      return cached.value;
    }
    let value: string | null = null;
    try {
      const raw = this.readFile(join(this.dir, fileName)).trim();
      value = raw.length > 0 ? raw : null;
    } catch {
      // Missing file (ENOENT) or unreadable → treat as unset; the caller
      // falls back to env. Do not throw: a partial mount must not crash.
      value = null;
    }
    this.cache.set(fileName, { value, readAtMs: now });
    return value;
  }

  private envFallback(name: SecretName, suffix = ""): string | null {
    const v = process.env[`${ENV_FALLBACK[name]}${suffix}`]?.trim();
    return v && v.length > 0 ? v : null;
  }

  getSecret(name: SecretName): string | null {
    return this.readKeyFile(name) ?? this.envFallback(name);
  }

  getRotatable(name: SecretName): RotatableSecret {
    return {
      current: this.readKeyFile(name) ?? this.envFallback(name),
      previous:
        this.readKeyFile(`${name}.previous`) ??
        this.envFallback(name, "_PREVIOUS"),
    };
  }
}
