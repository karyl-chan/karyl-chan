/** Inspect one Node TAP transcript for the no-skip/no-noop CI contract. */
export function inspectRequiredTap(output, marker) {
  const failures = [];
  if (!output.includes(marker)) {
    failures.push(`required marker was absent: ${JSON.stringify(marker)}`);
  }
  if (/^(?:not )?ok\b.*\#\s*(?:SKIP|TODO)\b/im.test(output)) {
    failures.push("required test reported SKIP or TODO");
  }
  if (!/\# pass [1-9][0-9]*\b/.test(output)) {
    failures.push("no passing test was reported");
  }
  return failures;
}
