const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

export function parseWhen(input: string, nowMs: number): number | null {
  const trimmed = input.trim().toLowerCase();
  const m = trimmed.match(/^(\d+)\s*([a-z]+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2]];
  if (!unit || !Number.isFinite(n) || n <= 0) return null;
  return nowMs + n * unit;
}
