import assert from "node:assert/strict";
import test from "node:test";
import { rewriteMetadataTarballOrigins } from "@red-cup-engineering/npm-registry-read-service";

test("REGISTRY-READ-QUICKSTART", () => {
  const original = {name: "@example/package", versions: { "1.0.0": { name: "@example/package", version: "1.0.0", dist: { tarball: "https://origin.example.test/a.tgz" } } } };
  const updated = rewriteMetadataTarballOrigins(original, "https://mirror.example.test");
  assert.equal(updated.versions["1.0.0"].dist.tarball, "https://mirror.example.test/@example/package/-/package-1.0.0.tgz");
  assert.equal(original.versions["1.0.0"].dist.tarball, "https://origin.example.test/a.tgz");
});
