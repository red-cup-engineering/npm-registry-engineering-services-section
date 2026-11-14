import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { admitNpmPackageArchive } from "@red-cup-engineering/npm-registry-engineering-services-section/admit-npm-package-archive";
import { measureArtifactBytes } from "../scripts/npm-artifact-integrity-service.mjs";

const identity = { name: "@causeway-services/news-fixture", version: "0.1.12-dev.77" };
function tarMember(document) {
  const body = Buffer.from(JSON.stringify(document)), header = Buffer.alloc(512);
  header.write("package/package.json");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108); header.write("0000000\0", 116);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const archive = (...parts) => gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
const admit = (bytes, manifest = identity) => admitNpmPackageArchive(bytes, {
  manifest, integrity: measureArtifactBytes(bytes).integrity,
});

test("the exported archive gate measures an exact prerelease and its runtime dependencies", () => {
  const manifest = { ...identity, dependencies: { helper: "1.2.3" } };
  const bytes = archive(tarMember({ ...manifest, optionalDependencies: {} }));
  assert.deepEqual(admit(bytes, manifest), { ...identity, measurement: measureArtifactBytes(bytes) });
});

test("the gate requires measured integrity before interpreting an archive", () => {
  assert.throws(() => admitNpmPackageArchive(Buffer.from("not a gzip file"), {
    manifest: identity, integrity: measureArtifactBytes(Buffer.from("different")).integrity,
  }), { code: "NPM_ARCHIVE_INTEGRITY_MISMATCH" });
});

test("the gate refuses mismatched releases and dependency graphs with valid archive hashes", () => {
  assert.throws(() => admit(archive(tarMember({ ...identity, version: "0.1.11" }))),
    { code: "NPM_ARCHIVE_IDENTITY_MISMATCH" });
  assert.throws(() => admit(archive(tarMember({ ...identity, peerDependencies: { helper: "2.0.0" } })),
    { ...identity, peerDependencies: { helper: "1.0.0" } }), { code: "NPM_ARCHIVE_DEPENDENCY_MISMATCH" });
  assert.throws(() => admit(archive(tarMember({ ...identity, devDependencies: { helper: "workspace:*" } }))),
    { code: "NPM_ARCHIVE_LOCAL_PROTOCOL" });
});

test("the gate refuses missing or duplicate embedded manifests", () => {
  for (const bytes of [archive(), archive(tarMember(identity), tarMember(identity))])
    assert.throws(() => admit(bytes), { code: "INVALID_NPM_ARCHIVE_MANIFEST" });
});

test("required and optional peer edges cannot disagree between archive and packument", () => {
  const required = { ...identity, peerDependencies: { helper: "1.0.0" } };
  const optional = { ...required, peerDependenciesMeta: { helper: { optional: true } } };
  const explicitRequired = { ...required, peerDependenciesMeta: { helper: { optional: false } } };
  assert.doesNotThrow(() => admit(archive(tarMember(optional)), optional));
  assert.doesNotThrow(() => admit(archive(tarMember(explicitRequired)), required));
  for (const [embedded, supplied] of [[optional, required], [required, optional]]) {
    assert.throws(() => admit(archive(tarMember(embedded)), supplied),
      { code: "NPM_ARCHIVE_DEPENDENCY_MISMATCH" });
  }
  assert.throws(() => admit(archive(tarMember({ ...required, peerDependenciesMeta: { helper: { optional: "true" } } })), required),
    { code: "INVALID_NPM_ARCHIVE_MANIFEST" });
});
