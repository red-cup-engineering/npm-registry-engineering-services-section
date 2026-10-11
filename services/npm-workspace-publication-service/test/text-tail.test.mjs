import assert from "node:assert/strict";
import { test } from "node:test";
import { lastLines } from "../src/text-tail.mjs";

test("returns all lines when there are fewer than count", () => {
  assert.equal(lastLines("a\nb", 20), "a\nb");
});

test("returns only the trailing count lines", () => {
  const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
  const tail = lastLines(text, 20);
  assert.equal(tail.split("\n").length, 20);
  assert.equal(tail.split("\n")[0], "line 10");
  assert.equal(tail.split("\n").at(-1), "line 29");
});

test("empty input yields an empty string, not an array with one empty element", () => {
  assert.equal(lastLines("", 20), "");
});

test("count of zero yields an empty string", () => {
  assert.equal(lastLines("a\nb\nc", 0), "");
});

test("throws on non-string text or a negative/non-integer count", () => {
  assert.throws(() => lastLines(123, 20), TypeError);
  assert.throws(() => lastLines("a", -1), TypeError);
  assert.throws(() => lastLines("a", 1.5), TypeError);
});
