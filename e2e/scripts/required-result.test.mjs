import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inspectRequiredTap } from "./required-result.mjs";

describe("required E2E TAP inspection", () => {
  it("accepts a passing suite and does not mistake zero summaries for annotations", () => {
    const output = [
      "ok 1 - lifecycle",
      "# pass 3",
      "# skipped 0",
      "# todo 0",
    ].join("\n");

    assert.deepEqual(inspectRequiredTap(output, "lifecycle"), []);
  });

  it("rejects a required suite that Node reports as skipped", () => {
    const output = [
      "ok 1 - lifecycle # SKIP missing TEST_E2E_DB_URL",
      "# pass 0",
      "# skipped 1",
    ].join("\n");

    assert.deepEqual(inspectRequiredTap(output, "lifecycle"), [
      "required test reported SKIP or TODO",
      "no passing test was reported",
    ]);
  });

  it("rejects a no-op transcript even when its marker was printed", () => {
    assert.deepEqual(inspectRequiredTap("# lifecycle\n# pass 0", "lifecycle"), [
      "no passing test was reported",
    ]);
  });

  it("rejects a passing but unrelated test file", () => {
    assert.deepEqual(
      inspectRequiredTap("ok 1 - other\n# pass 1", "lifecycle"),
      ['required marker was absent: "lifecycle"'],
    );
  });
});
