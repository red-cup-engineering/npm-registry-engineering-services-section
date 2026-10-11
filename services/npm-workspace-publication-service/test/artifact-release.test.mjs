import assert from "node:assert/strict";
import { test } from "node:test";
import { admitArtifactRelease } from "../src/artifact-release.mjs";

const manifest = Object.freeze({ name: "@red-cup-engineering/example", version: "0.1.0", exports: { ".": "./dist/index.mjs" } });
const input = Object.freeze({
  registry: "https://registry.561.group",
  manifest,
  tarballManifest: manifest,
  tarballInventory: ["package.json", "dist/index.mjs"],
  installedManifest: manifest,
  installedInventory: ["dist/index.mjs", "package.json"],
  imports: [{ specifier: "@red-cup-engineering/example", status: "imported", exports: ["answer"] }],
});

test("an ArtifactRelease derives one replayable identity from matching manifest, tarball, install, and imports", () => {
  const first = admitArtifactRelease(input);
  const second = admitArtifactRelease(input);
  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.match(first.value.identity, /^ni:\/\//u);
  assert.deepEqual(first.value.tarball.inventory, ["dist/index.mjs", "package.json"]);
});

test("an ArtifactRelease refuses promotion when the installed artifact differs from its tarball", () => {
  const result = admitArtifactRelease({ ...input, installedInventory: ["package.json"] });
  assert.deepEqual(result, {
    ok: false,
    refusal: {
      code: "artifact-release-mismatch",
      releaseIdentity: result.refusal.releaseIdentity,
      manifestMismatch: false,
      inventory: { absentFromTarball: [], absentFromInstalledPackage: ["dist/index.mjs"] },
    },
  });
});
