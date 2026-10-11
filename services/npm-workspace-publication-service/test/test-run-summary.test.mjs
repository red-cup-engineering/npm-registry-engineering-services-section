import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTestRunSummary } from "../src/test-run-summary.mjs";

test("parses the default spec-reporter summary lines", () => {
  const output = [
    "✔ some test (1.234ms)",
    "ℹ tests 10",
    "ℹ suites 0",
    "ℹ pass 9",
    "ℹ fail 1",
    "ℹ cancelled 0",
    "ℹ skipped 0",
    "ℹ todo 0",
    "ℹ duration_ms 12.345",
  ].join("\n");
  assert.deepEqual(parseTestRunSummary(output), { tests: 10, pass: 9, fail: 1 });
});

test("parses the tap-reporter summary lines", () => {
  const output = ["# tests 5", "# pass 5", "# fail 0"].join("\n");
  assert.deepEqual(parseTestRunSummary(output), { tests: 5, pass: 5, fail: 0 });
});

test("throws when no recognizable summary is present", () => {
  assert.throws(() => parseTestRunSummary("npm ERR! some unrelated failure\n"), /did not carry a recognizable summary/);
});

test("throws on non-string input rather than silently returning zero counts", () => {
  assert.throws(() => parseTestRunSummary(undefined), /did not carry a recognizable summary/);
});
