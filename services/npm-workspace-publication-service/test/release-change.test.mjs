import test from "node:test";
import assert from "node:assert/strict";
import { releaseBumpAllowsChange } from "../src/release-wave.mjs";

test("breaking changes advance minor before 1.0 and major thereafter", () => {
  assert.equal(releaseBumpAllowsChange("0.3.0", "minor", "breaking"), true);
  assert.equal(releaseBumpAllowsChange("0.3.0", "patch", "breaking"), false);
  assert.equal(releaseBumpAllowsChange("0.3.0", null, "breaking"), false);
  assert.equal(releaseBumpAllowsChange("1.3.0", "minor", "breaking"), false);
  assert.equal(releaseBumpAllowsChange("1.3.0", "major", "breaking"), true);
});
