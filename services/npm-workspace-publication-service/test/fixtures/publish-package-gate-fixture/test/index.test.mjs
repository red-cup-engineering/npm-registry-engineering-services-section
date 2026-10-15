import assert from "node:assert/strict";
import { test } from "node:test";
import { one } from "../index.mjs";

test("one is 1", () => {
  assert.equal(one(), 1);
});
