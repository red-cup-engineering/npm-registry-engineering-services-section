import assert from "node:assert/strict";
import test from "node:test";
import { selectRegistryPackages } from "@red-cup-engineering/package-installation-check-service";

test("INSTALLATION-QUICKSTART", () => {
  const releases = [{ name: "@example/tool", version: "1.0.0" }, { name: "@example/tool", version: "2.0.0" }];
  assert.deepEqual(selectRegistryPackages(releases, ["@example/tool@2.0.0"]), [releases[1]]);
});
