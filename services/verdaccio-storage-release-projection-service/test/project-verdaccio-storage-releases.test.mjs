import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { EXCLUSION_REASONS, projectVerdaccioStorageReleases } from "../src/project-verdaccio-storage-releases.mjs";

function field(value, length) { const bytes = Buffer.alloc(length); Buffer.from(value).copy(bytes); return bytes; }
function tarball(manifest) {
  const body = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(512);
  field("package/package.json", 100).copy(header, 0);
  field("0000644\0", 8).copy(header, 100);
  field(`${body.length.toString(8).padStart(11, "0")}\0`, 12).copy(header, 124);
  field("0", 1).copy(header, 156);
  field("ustar\0", 6).copy(header, 257);
  header.fill(0x20, 148, 156);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 8).copy(header, 148);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512), Buffer.alloc(1024)]));
}
function hashes(bytes) { return { shasum: createHash("sha1").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }; }
async function fixture(run) { const root = await mkdtemp(join(tmpdir(), "verdaccio-release-projection-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function release(root, name, version, { manifest = {}, artifactManifest, attachment = true, bytes, dist = {} } = {}) {
  const leaf = `${name.split("/").at(-1)}-${version}.tgz`;
  const artifact = bytes ?? tarball(artifactManifest ?? { name, version });
  const digest = hashes(artifact);
  const path = join(root, ...name.split("/"));
  await mkdir(path, { recursive: true });
  const versionManifest = { name, version, ...manifest, dist: { tarball: `http://registry.invalid/${name}/-/${leaf}`, ...digest, ...dist } };
  await writeFile(join(path, "package.json"), JSON.stringify({ name, versions: { [version]: versionManifest }, _attachments: attachment ? { [leaf]: { version, shasum: digest.shasum } } : {} }));
  if (attachment) await writeFile(join(path, leaf), artifact);
}
async function index(root, list) { await writeFile(join(root, ".verdaccio-db.json"), JSON.stringify({ list, secret: "this must never appear in output" })); }

test("projects the production scoped Verdaccio layout into snapshot release inputs", async () => fixture(async (root) => {
  await release(root, "@red-cup-engineering/alpha", "1.2.3");
  await index(root, ["@red-cup-engineering/alpha"]);
  const result = await projectVerdaccioStorageReleases({ storageRoot: root, ownedScopes: ["red-cup-engineering"] });
  assert.equal(result.admitted.length, 1);
  assert.equal(result.admitted[0].manifest.name, "@red-cup-engineering/alpha");
  assert.equal(result.admitted[0].manifest.version, "1.2.3");
  assert.match(result.admitted[0].artifactPath, /@red-cup-engineering\/alpha\/alpha-1\.2\.3\.tgz$/u);
  assert.equal(result.admitted[0].measurement.bytes > 0, true);
  assert.equal(JSON.stringify(result).includes("this must never appear"), false);
}));

test("reports all intentional exclusion classes in stable order and counts", async () => fixture(async (root) => {
  await release(root, "@red-cup-engineering/local", "1.0.0", { manifest: { dependencies: { x: "workspace:*" } } });
  await release(root, "@red-cup-engineering/prerelease", "1.0.0-beta");
  await release(root, "@emsenn/legacy", "1.0.0");
  await release(root, "plain-package", "1.0.0");
  await release(root, "@other/not-ours", "1.0.0");
  await index(root, ["@other/not-ours", "plain-package", "@emsenn/legacy", "@red-cup-engineering/prerelease", "@red-cup-engineering/local"]);
  const result = await projectVerdaccioStorageReleases({ storageRoot: root, ownedScopes: ["red-cup-engineering", "emsenn"], ownedUnscopedNames: ["plain-package"] });
  assert.deepEqual(result.excluded.map(({ name, version, reason }) => [name, version, reason]), [
    ["@emsenn/legacy", "1.0.0", EXCLUSION_REASONS.NON_SOVEREIGN_IDENTITY],
    ["@other/not-ours", "1.0.0", EXCLUSION_REASONS.NOT_OWNED],
    ["@red-cup-engineering/local", "1.0.0", EXCLUSION_REASONS.LOCAL_DEPENDENCY_PROTOCOL],
    ["@red-cup-engineering/prerelease", "1.0.0-beta", EXCLUSION_REASONS.NON_EXACT_VERSION],
    ["plain-package", "1.0.0", EXCLUSION_REASONS.UNSCOPED_IDENTITY],
  ]);
  for (const item of result.excluded) {
    assert.equal(typeof item.artifactPath, "string");
    assert.equal(item.measurement.bytes > 0, true);
    assert.equal(item.manifest.name, item.name);
  }
  assert.deepEqual(result.counts.excludedByReason, { "not-owned": 1, "unscoped-identity": 1, "non-sovereign-identity": 1, "non-exact-version": 1, "local-dependency-protocol": 1 });
}));

test("hard-refuses missing attachments, mismatched digests, and mismatched artifact identity", async () => fixture(async (root) => {
  await release(root, "@red-cup-engineering/missing", "1.0.0", { attachment: false });
  await index(root, ["@red-cup-engineering/missing"]);
  await assert.rejects(projectVerdaccioStorageReleases({ storageRoot: root, ownedScopes: ["red-cup-engineering"] }), /does not resolve to an attachment/u);
  await release(root, "@red-cup-engineering/hash", "1.0.0", { dist: { shasum: "0".repeat(40) } });
  await index(root, ["@red-cup-engineering/hash"]);
  await assert.rejects(projectVerdaccioStorageReleases({ storageRoot: root, ownedScopes: ["red-cup-engineering"] }), /hashes do not equal/u);
  await release(root, "@red-cup-engineering/identity", "1.0.0", { artifactManifest: { name: "@red-cup-engineering/other", version: "1.0.0" } });
  await index(root, ["@red-cup-engineering/identity"]);
  await assert.rejects(projectVerdaccioStorageReleases({ storageRoot: root, ownedScopes: ["red-cup-engineering"] }), /artifact package manifest identity\/version/u);
}));
