import assert from "node:assert/strict";
import test from "node:test";
import { verificationCopyFilter } from "../src/verification-copy.mjs";
import { publicationTemporaryRoot } from "../src/isolated-carrier-verification.mjs";

test("registry verification copies source but excludes local installations and npm transport authority", () => {
  assert.equal(verificationCopyFilter("/workspace/package.json"), true);
  assert.equal(verificationCopyFilter("/workspace/src/index.mjs"), true);
  for (const name of ["node_modules", ".git", "dist", "package-lock.json", ".npmrc"]) {
    assert.equal(verificationCopyFilter(`/workspace/${name}`), false, name);
    assert.equal(verificationCopyFilter(`/workspace/nested/${name}`), false, `nested ${name}`);
  }
});

test("Linux carrier verification does not inherit a Windows-mounted TEMP substrate", () => {
  assert.equal(publicationTemporaryRoot({ TEMP: "/mnt/c/Users/example/Temp" }, "linux"), "/tmp");
  assert.equal(publicationTemporaryRoot({ NPM_PUBLICATION_TEMP_ROOT: "/var/tmp/npm-publication" }, "linux"), "/var/tmp/npm-publication");
  assert.throws(() => publicationTemporaryRoot({ NPM_PUBLICATION_TEMP_ROOT: "relative" }, "linux"), /must be absolute/u);
});
