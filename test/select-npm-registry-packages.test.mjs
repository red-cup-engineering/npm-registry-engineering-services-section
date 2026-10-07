import assert from "node:assert/strict";
import test from "node:test";
import { selectNpmRegistryPackages } from "../scripts/select-npm-registry-packages.mjs";

const packages = [
  { name: "@customer/example", version: "1.0.0", digest: "one" },
  { name: "@customer/example", version: "2.0.0", digest: "two" },
  { name: "@customer/other", version: "1.0.0", digest: "three" },
];

test("selects exact and unambiguous named releases in selector order", () => {
  assert.deepEqual(selectNpmRegistryPackages({ type: "NpmRegistryPackageSelectionRequest", version: 1, packages, selections: ["@customer/other", "@customer/example@2.0.0"] }), {
    type: "NpmRegistryPackageSelection", version: 1, selections: ["@customer/other", "@customer/example@2.0.0"], packages: [packages[2], packages[1]],
  });
});

test("an empty selection explicitly selects every supplied release", () => {
  assert.deepEqual(selectNpmRegistryPackages({ type: "NpmRegistryPackageSelectionRequest", version: 1, packages, selections: [] }).packages, packages);
});

test("refuses absent, ambiguous, and malformed selections", () => {
  assert.throws(() => selectNpmRegistryPackages({ type: "NpmRegistryPackageSelectionRequest", version: 1, packages, selections: ["@customer/example"] }), /version-ambiguous/);
  assert.throws(() => selectNpmRegistryPackages({ type: "NpmRegistryPackageSelectionRequest", version: 1, packages, selections: ["@customer/absent"] }), /absent/);
  assert.throws(() => selectNpmRegistryPackages({ type: "NpmRegistryPackageSelectionRequest", version: 1, packages, selections: [3] }), TypeError);
});
