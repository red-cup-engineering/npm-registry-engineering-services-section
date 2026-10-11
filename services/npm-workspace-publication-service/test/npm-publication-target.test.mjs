import assert from "node:assert/strict";
import test from "node:test";
import { npmPublicationRegistryArguments } from "../src/npm-publication-target.mjs";

test("scoped publication overrides both default and scope-specific read registries", () => {
  assert.deepEqual(npmPublicationRegistryArguments("@red-cup-engineering/metrologic", "https://write.example/repository"), [
    "--registry=https://write.example/repository",
    "--@lenticule-science:registry=https://write.example/repository",
  ]);
});

test("unscoped publication needs only the default registry override", () => {
  assert.deepEqual(npmPublicationRegistryArguments("example", "https://write.example/"), ["--registry=https://write.example/"]);
  assert.throws(() => npmPublicationRegistryArguments("@broken", "https://write.example/"), /invalid/u);
});
