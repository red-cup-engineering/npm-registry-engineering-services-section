import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";

const SOVEREIGN_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const LOCAL_PROTOCOL = /^(?:workspace:|file:|link:)/u;

export const EXCLUSION_REASONS = Object.freeze({
  NOT_OWNED: "not-owned",
  UNSCOPED_IDENTITY: "unscoped-identity",
  NON_SOVEREIGN_IDENTITY: "non-sovereign-identity",
  NON_EXACT_VERSION: "non-exact-version",
  LOCAL_DEPENDENCY_PROTOCOL: "local-dependency-protocol",
});

function excluded({ name, version, reason, detail, manifest, artifactPath, measurement }) {
  return Object.freeze({ name, version, reason, detail, manifest: Object.freeze({ ...manifest }), artifactPath, measurement });
}

function measure(bytes) {
  return Object.freeze({
    bytes: bytes.byteLength,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  });
}

function packageDirectory(storageRoot, name) {
  return join(storageRoot, ...name.split("/"));
}

function tarballFilename(value) {
  if (typeof value !== "string" || value === "") return null;
  try { return decodeURIComponent(new URL(value).pathname.split("/").at(-1)); } catch { return null; }
}

function tarEntryName(header) {
  const zero = (value) => value.indexOf(0) === -1 ? value.length : value.indexOf(0);
  const prefix = header.subarray(345, 500).toString("utf8", 0, zero(header.subarray(345, 500)));
  const name = header.subarray(0, 100).toString("utf8", 0, zero(header.subarray(0, 100)));
  return prefix ? `${prefix}/${name}` : name;
}

function tarEntrySize(header) {
  const raw = header.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
  if (!/^[0-7]*$/u.test(raw)) throw new Error("artifact tar entry has an invalid size");
  return Number.parseInt(raw || "0", 8);
}

// The projected artifact, not only Verdaccio's packument, must attest to the
// release identity.  This is a read-only tar parser: it never extracts paths.
function artifactManifest(bytes) {
  let tar;
  try { tar = gunzipSync(bytes); } catch { throw new Error("artifact is not a readable gzip tarball"); }
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarEntrySize(header);
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error("artifact tar entry exceeds artifact bytes");
    if (tarEntryName(header) === "package/package.json") {
      try { return JSON.parse(tar.subarray(start, end).toString("utf8")); } catch { throw new Error("artifact package manifest is not JSON"); }
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error("artifact does not contain package/package.json");
}

function localDependency(manifest) {
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, value] of Object.entries(manifest[field] ?? {})) {
      if (typeof value === "string" && LOCAL_PROTOCOL.test(value)) return { field, name, value };
    }
  }
  return null;
}

function identityExclusion(name, version, ownedScopes, ownedUnscopedNames) {
  if (!name.startsWith("@")) {
    if (ownedUnscopedNames.has(name)) return { reason: EXCLUSION_REASONS.UNSCOPED_IDENTITY, detail: "snapshot assembly accepts scoped package identities only" };
    return { reason: EXCLUSION_REASONS.NOT_OWNED, detail: "package name is not explicitly owned" };
  }
  const scope = /^@([^/]+)\//u.exec(name)?.[1];
  if (!ownedScopes.has(scope)) return { reason: EXCLUSION_REASONS.NOT_OWNED, detail: "package scope is not explicitly owned" };
  if (!SOVEREIGN_NAME.test(name) || name.startsWith("@emsenn/")) return { reason: EXCLUSION_REASONS.NON_SOVEREIGN_IDENTITY, detail: "package identity is not accepted by snapshot assembly" };
  return null;
}

function hardRefuse(surface, detail) {
  throw new Error(`legacy release projection refused ${surface}: ${detail}`);
}

/**
 * Projects only explicit, indexed ownership from Verdaccio's legacy storage.
 * It reads, hashes, and artifact-attests each candidate, but writes nothing.
 */
export async function projectVerdaccioStorageReleases({ storageRoot, ownedScopes, ownedUnscopedNames = [] } = {}) {
  if (typeof storageRoot !== "string" || storageRoot === "") throw new TypeError("storageRoot must be a non-empty string");
  if (!Array.isArray(ownedScopes) || ownedScopes.length === 0 || ownedScopes.some((scope) => typeof scope !== "string" || scope === "")) throw new TypeError("ownedScopes must name at least one scope");
  if (!Array.isArray(ownedUnscopedNames) || ownedUnscopedNames.some((name) => typeof name !== "string" || name === "")) throw new TypeError("ownedUnscopedNames must be an array of non-empty names");
  const root = resolve(storageRoot);
  const scopes = new Set(ownedScopes);
  const unscoped = new Set(ownedUnscopedNames);
  let db;
  try { db = JSON.parse(await readFile(join(root, ".verdaccio-db.json"), "utf8")); } catch (error) { hardRefuse("registry index", error?.code === "ENOENT" ? "index is absent" : "index is not JSON"); }
  if (!Array.isArray(db.list)) hardRefuse("registry index", "index list is absent or malformed");

  const admitted = [], exclusions = [];
  for (const name of [...new Set(db.list)].sort((a, b) => String(a).localeCompare(String(b)))) {
    if (typeof name !== "string") hardRefuse("registry index", "index contains a non-string package name");
    let packument;
    try { packument = JSON.parse(await readFile(join(packageDirectory(root, name), "package.json"), "utf8")); } catch (error) { hardRefuse(name, error?.code === "ENOENT" ? "indexed package metadata is missing" : "package metadata is not JSON"); }
    if (!packument || typeof packument !== "object" || Array.isArray(packument) || packument.name !== name || !packument.versions || typeof packument.versions !== "object") hardRefuse(name, "packument identity or versions is malformed");
    for (const version of Object.keys(packument.versions).sort()) {
      const manifest = packument.versions[version];
      const rejection = identityExclusion(name, version, scopes, unscoped);
      if (manifest?.name !== name) hardRefuse(`${name}@${version}`, "manifest name does not equal indexed package name");
      const filename = tarballFilename(manifest.dist?.tarball);
      const attachment = filename && packument._attachments?.[filename];
      if (!filename || !attachment || attachment.version !== version) hardRefuse(`${name}@${version}`, "dist tarball does not resolve to an attachment for this version");
      let bytes;
      try { bytes = await readFile(join(packageDirectory(root, name), filename)); } catch (error) { hardRefuse(`${name}@${version}`, error?.code === "ENOENT" ? "declared attachment is missing" : "declared attachment cannot be read"); }
      const measurement = measure(bytes);
      if (manifest.dist.shasum !== measurement.shasum || manifest.dist.integrity !== measurement.integrity || (attachment.shasum !== undefined && attachment.shasum !== measurement.shasum)) hardRefuse(`${name}@${version}`, "declared artifact hashes do not equal stored bytes");
      const artifact = artifactManifest(bytes);
      if (artifact?.name !== name || artifact?.version !== version) hardRefuse(`${name}@${version}`, "artifact package manifest identity/version does not equal packument release");
      const evidence = { name, version, manifest, artifactPath: join(packageDirectory(root, name), filename), measurement };
      if (rejection !== null) { exclusions.push(excluded({ ...evidence, reason: rejection.reason, detail: rejection.detail })); continue; }
      if (!EXACT_VERSION.test(version) || manifest.version !== version) { exclusions.push(excluded({ ...evidence, reason: EXCLUSION_REASONS.NON_EXACT_VERSION, detail: "packument version must be exact x.y.z and equal manifest.version" })); continue; }
      const local = localDependency(manifest);
      if (local !== null) { exclusions.push(excluded({ ...evidence, reason: EXCLUSION_REASONS.LOCAL_DEPENDENCY_PROTOCOL, detail: local })); continue; }
      admitted.push(Object.freeze({ manifest: Object.freeze({ ...manifest }), artifactPath: join(packageDirectory(root, name), filename), measurement }));
    }
  }
  admitted.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.manifest.version.localeCompare(b.manifest.version, undefined, { numeric: true }));
  exclusions.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)) || a.reason.localeCompare(b.reason));
  const excludedByReason = Object.fromEntries(Object.values(EXCLUSION_REASONS).map((reason) => [reason, exclusions.filter((item) => item.reason === reason).length]));
  return Object.freeze({
    type: "VerdaccioStorageReleaseProjection",
    version: 1,
    storageRoot: root,
    admitted: Object.freeze(admitted),
    excluded: Object.freeze(exclusions),
    counts: Object.freeze({ indexedPackages: new Set(db.list).size, admitted: admitted.length, excluded: exclusions.length, excludedByReason: Object.freeze(excludedByReason) }),
  });
}
