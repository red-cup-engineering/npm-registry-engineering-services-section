import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestRole, semanticVersionPolicyViolations } from "../src/semantic-version-policy.mjs";

test("semantic version policy accepts stable and development carrier identities", () => {
  assert.deepEqual(semanticVersionPolicyViolations({ name: "stable", version: "0.2.3", exports: "./index.mjs" }), []);
  assert.deepEqual(semanticVersionPolicyViolations({ name: "development", version: "0.2.4-dev.0", exports: "./index.mjs" }), []);
  assert.deepEqual(semanticVersionPolicyViolations({ name: "release-candidate", version: "0.2.4-rc.0", exports: "./index.mjs" }), []);
});

test("semantic version policy refuses malformed and missing carrier identities", () => {
  assert.match(semanticVersionPolicyViolations({ name: "malformed", version: "1.2", exports: "./index.mjs" })[0].reason, /stable X\.Y\.Z/u);
  assert.equal(semanticVersionPolicyViolations({ name: "missing", exports: "./index.mjs" })[0].field, "version");
  assert.deepEqual(semanticVersionPolicyViolations({ version: "0.2.3", scripts: { test: "node --test" } }), [{
    field: "name", reason: "carrier manifest requires a nonempty package name",
  }]);
});

test("semantic version policy exempts descriptive section metadata", () => {
  const section = { name: "@example/services-section", description: "A directory description." };
  assert.equal(manifestRole(section), "section-metadata");
  assert.deepEqual(semanticVersionPolicyViolations(section), []);
});

test("semantic version policy binds a present lock root to the carrier identity", () => {
  const manifest = { name: "@example/carrier", version: "0.2.3", exports: "./index.mjs" };
  const lock = { packages: { "": { name: "@example/carrier", version: "0.2.2" } } };
  assert.deepEqual(semanticVersionPolicyViolations(manifest, lock), [{
    field: "version", manifestValue: "0.2.3", lockValue: "0.2.2", reason: "package-lock root version must equal package.json",
  }]);
});
