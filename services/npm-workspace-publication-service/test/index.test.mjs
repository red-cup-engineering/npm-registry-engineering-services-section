import assert from "node:assert/strict";
import { test } from "node:test";
import { one } from "../scripts/publish-package-gate-fixture.mjs";

test("one is 1", () => {
  assert.equal(one(), 1);
});
