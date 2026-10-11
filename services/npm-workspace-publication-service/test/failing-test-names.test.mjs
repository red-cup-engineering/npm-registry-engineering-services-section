import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFailingTestNames } from "../src/failing-test-names.mjs";

test("a fully passing spec-reporter run yields no failing names", () => {
  const output = ["✔ one thing (1.2ms)", "✔ another thing (0.5ms)", "ℹ tests 2", "ℹ pass 2", "ℹ fail 0"].join("\n");
  assert.deepEqual(parseFailingTestNames(output), []);
});

test("one failing spec-reporter test is named once, though it prints inline and in the recap", () => {
  const output = [
    "✔ passes (1ms)",
    "✖ deduplicates a name exported twice (2.08ms)",
    "ℹ tests 2",
    "ℹ pass 1",
    "ℹ fail 1",
    "",
    "✖ failing tests:",
    "",
    "test at test/example.test.mjs:32:1",
    "✖ deduplicates a name exported twice (2.08ms)",
    "  SyntaxError: Duplicate export 'f'",
  ].join("\n");
  assert.deepEqual(parseFailingTestNames(output), ["deduplicates a name exported twice"]);
});

test("multiple distinct failing spec-reporter tests are all named, in first-seen order", () => {
  const output = [
    "✖ first failure (1ms)",
    "✔ passes (1ms)",
    "✖ second failure (2ms)",
    "ℹ tests 3",
    "ℹ pass 1",
    "ℹ fail 2",
  ].join("\n");
  assert.deepEqual(parseFailingTestNames(output), ["first failure", "second failure"]);
});

test("tap-reporter failures are named via not ok lines", () => {
  const output = ["ok 1 - passes", "not ok 2 - breaks", "not ok 3 - also breaks", "# tests 3", "# pass 1", "# fail 2"].join("\n");
  assert.deepEqual(parseFailingTestNames(output), ["breaks", "also breaks"]);
});

test("non-string input yields an empty list rather than throwing", () => {
  assert.deepEqual(parseFailingTestNames(undefined), []);
  assert.deepEqual(parseFailingTestNames(null), []);
});
