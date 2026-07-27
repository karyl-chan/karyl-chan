/**
 * Minimal, zero-dependency semver comparison for SDK-version
 * coordinates. The Wire Contract states all compatibility in
 * SDK-version terms (Event Ceiling, Compat Floor), and both the bot's
 * compat check and the ceiling derivation compare versions with this
 * one helper — no `semver` package pulled in for what is a handful of
 * `major.minor.patch(-prerelease)?` strings.
 *
 * Prerelease ordering follows semver §11: a version with a prerelease
 * tag has LOWER precedence than the same version without one
 * (`1.0.0-rc.1` < `1.0.0`), and prerelease identifiers compare
 * left-to-right (numeric identifiers numerically, else lexically).
 */

function splitPrerelease(version: string): {
  core: [number, number, number];
  prerelease: string[] | null;
} {
  const [main, pre] = version.split("-", 2);
  const parts = main.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const core: [number, number, number] = [
    parts[0] ?? 0,
    parts[1] ?? 0,
    parts[2] ?? 0,
  ];
  return {
    core,
    prerelease: pre ? pre.split(".") : null,
  };
}

/**
 * Returns a negative number when `a < b`, zero when equal, positive
 * when `a > b`.
 */
export function compareSemver(a: string, b: string): number {
  const va = splitPrerelease(a);
  const vb = splitPrerelease(b);

  for (let i = 0; i < 3; i++) {
    if (va.core[i] !== vb.core[i]) return va.core[i] - vb.core[i];
  }

  // Equal core versions: the one WITH a prerelease tag ranks lower.
  if (va.prerelease && !vb.prerelease) return -1;
  if (!va.prerelease && vb.prerelease) return 1;
  if (!va.prerelease && !vb.prerelease) return 0;

  const pa = va.prerelease as string[];
  const pb = vb.prerelease as string[];
  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i], 10);
    const nb = Number.parseInt(pb[i], 10);
    const aNum = !Number.isNaN(na) && /^\d+$/.test(pa[i]);
    const bNum = !Number.isNaN(nb) && /^\d+$/.test(pb[i]);
    if (aNum && bNum) {
      if (na !== nb) return na - nb;
    } else if (aNum !== bNum) {
      // Numeric identifiers always rank lower than alphanumeric ones.
      return aNum ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  // A longer set of prerelease fields ranks higher when all preceding
  // fields are equal.
  return pa.length - pb.length;
}

/** The highest of a non-empty list of semver strings. */
export function maxSemver(versions: readonly string[]): string {
  return versions.reduce((hi, v) => (compareSemver(v, hi) > 0 ? v : hi));
}
