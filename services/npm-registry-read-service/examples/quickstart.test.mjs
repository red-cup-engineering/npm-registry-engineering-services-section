import assert from "node:assert/strict";
import test from "node:test";
import { rewriteMetadataTarballOrigins } from "@red-cup-engineering/npm-registry-read-service";

test("REGISTRY-READ-QUICKSTART", () => {
  const original = { versions: { "1.0.0": { dist: { tarball: "https://origin.example.test/a.tgz" } } } };
  const updated = rewriteMetadataTarballOrigins(original, "https://mirror.example.test");
  assert.equal(updated.versions["1.0.0"].dist.tarball, "https://mirror.example.test/a.tgz");
  assert.equal(original.versions["1.0.0"].dist.tarball, "https://origin.example.test/a.tgz");
});
