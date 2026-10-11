import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { verifyArtifactFile } from "@red-cup-engineering/npm-registry-services-section/npm-artifact-integrity-service";

const PACKAGE_NAME = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const LOCAL_PROTOCOL = /^(?:workspace:|file:|link:)/u;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];

export class PackageRegistrySnapshotVerificationError extends Error {
  constructor(defects) {
    super(`package registry snapshot verification failed with ${defects.length} defect${defects.length === 1 ? "" : "s"}`);
    this.name = "PackageRegistrySnapshotVerificationError";
    this.defects = defects;
  }
}

function inside(root, candidate) {
  const displacement = relative(root, candidate);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`));
}

function canonicalArtifact(name, version) {
  const scoped = name.startsWith("@");
  const slash = name.indexOf("/");
  const leaf = scoped ? name.slice(slash + 1) : name;
  const prefix = scoped ? `${name.slice(1, slash)}/${leaf}` : leaf;
  return `tarballs/${prefix}/-/${leaf}-${version}.tgz`;
}

function metadataNameFromCanonicalPath(file) {
  if (!file.endsWith(".json") || file.includes("/")) return null;
  try {
    const name = decodeURIComponent(file.slice(0, -".json".length));
    return PACKAGE_NAME.test(name) && file === `${encodeURIComponent(name)}.json` ? name : null;
  } catch { return null; }
}

function sortedDefects(defects) {
  return defects.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function defect(defects, code, detail = {}) {
  defects.push({ code, ...detail });
}

async function filesBelow(directory, prefix = "") {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path, relativePath));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(relativePath);
  }
  return files;
}

async function inspectRegularFileUnderRoot(rootReal, path) {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" };
    throw error;
  }
  if (!stat.isFile()) return { state: "unsafe" };
  let fileReal;
  try { fileReal = await realpath(path); } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" };
    throw error;
  }
  if (!inside(rootReal, fileReal)) return { state: "unsafe" };
  return { state: "regular", stat, realpath: fileReal };
}

async function readRegularFileUnderRoot(rootReal, path) {
  const before = await inspectRegularFileUnderRoot(rootReal, path);
  if (before.state !== "regular") return before;
  let contents;
  try { contents = await readFile(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing" };
    throw error;
  }
  const after = await inspectRegularFileUnderRoot(rootReal, path);
  if (after.state !== "regular"
    || before.realpath !== after.realpath
    || before.stat.dev !== after.stat.dev
    || before.stat.ino !== after.stat.ino) return { state: "unsafe" };
  return { state: "regular", contents };
}

function exactUrl(value) {
  try {
    const parsed = new URL(value);
    return typeof value === "string"
      && /^https?:$/u.test(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && value === parsed.href
      ? parsed.href
      : null;
  } catch { return null; }
}

function versionOrder(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function rejectLocalProtocols(defects, name, version, manifest) {
  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependency, constraint] of Object.entries(manifest?.[field] ?? {})) {
      if (typeof constraint === "string" && LOCAL_PROTOCOL.test(constraint)) {
        defect(defects, "LOCAL_DEPENDENCY_PROTOCOL", { name, version, field, dependency, constraint });
      }
    }
  }
}

// Validates a fully built directory rather than reconstructing it. Every receipt
// release, packument release, and tarball must have exactly one counterpart.
export async function verifyPackageRegistrySnapshot({ registryDirectory }) {
  const root = resolve(registryDirectory);
  const defects = [];
  let rootReal;
  try { rootReal = await realpath(root); } catch (error) {
    if (error?.code === "ENOENT") throw new TypeError("registryDirectory does not exist");
    throw error;
  }
  let receipt;
  const receiptPath = join(root, "registry-receipt.json");
  const receiptFile = await readRegularFileUnderRoot(rootReal, receiptPath);
  if (receiptFile.state === "missing") throw new TypeError("registry-receipt.json is required");
  if (receiptFile.state !== "regular") {
    defect(defects, "RECEIPT_NOT_REGULAR_UNDER_ROOT");
    receipt = {};
  } else try { receipt = JSON.parse(receiptFile.contents); } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("registry-receipt.json is not valid JSON");
    throw error;
  }
  if (receipt?.type !== "SemioticVoxelPackageRegistryReceipt" || receipt?.version !== 2) {
    defect(defects, "RECEIPT_SCHEMA", { actualType: receipt?.type ?? null, actualVersion: receipt?.version ?? null });
  }
  const registry = exactUrl(receipt?.registry);
  if (!registry) defect(defects, "RECEIPT_REGISTRY_URL", { actual: receipt?.registry ?? null });
  if (!Array.isArray(receipt?.packages)) {
    defect(defects, "RECEIPT_PACKAGES", { actual: receipt?.packages ?? null });
  }
  const entries = Array.isArray(receipt?.packages) ? receipt.packages : [];
  const receiptReleases = new Map();
  const expectedArtifacts = new Set();
  for (const entry of entries) {
    const name = entry?.name;
    const version = entry?.version;
    const identity = `${name}@${version}`;
    if (!PACKAGE_NAME.test(name ?? "")) defect(defects, "RECEIPT_PACKAGE_NAME", { identity, actual: name ?? null });
    if (!VERSION.test(version ?? "")) defect(defects, "RECEIPT_PACKAGE_VERSION", { identity, actual: version ?? null });
    if (!PACKAGE_NAME.test(name ?? "") || !VERSION.test(version ?? "")) continue;
    if (receiptReleases.has(identity)) defect(defects, "DUPLICATE_RECEIPT_RELEASE", { identity });
    receiptReleases.set(identity, entry);
    const artifact = canonicalArtifact(name, version);
    if (entry.artifact !== artifact) defect(defects, "RECEIPT_ARTIFACT_COORDINATES", { identity, expected: artifact, actual: entry.artifact ?? null });
    expectedArtifacts.add(artifact);
    const artifactPath = resolve(root, entry.artifact ?? "");
    if (!inside(root, artifactPath)) {
      defect(defects, "ARTIFACT_OUTSIDE_ROOT", { identity, artifact: entry.artifact ?? null });
      continue;
    }
    try {
      const artifactReal = await realpath(artifactPath);
      const stat = await lstat(artifactPath);
      if (!inside(rootReal, artifactReal) || !stat.isFile()) defect(defects, "ARTIFACT_NOT_REGULAR_UNDER_ROOT", { identity, artifact: entry.artifact ?? null });
      else {
        const verification = await verifyArtifactFile(artifactPath, {
          bytes: entry.bytes,
          shasum: entry.shasum,
          integrity: entry.integrity,
        });
        for (const field of verification.mismatches) {
          defect(defects, "RECEIPT_ARTIFACT_DIGEST", { identity, field, expected: entry[field] ?? null, actual: verification.measurement[field] });
        }
      }
    } catch (error) {
      if (error?.code === "ENOENT") defect(defects, "ARTIFACT_MISSING", { identity, artifact: entry.artifact ?? null });
      else throw error;
    }
    const expectedTarball = registry ? new URL(artifact, registry).href : null;
    if (entry.tarball !== expectedTarball) defect(defects, "RECEIPT_TARBALL_URL", { identity, expected: expectedTarball, actual: entry.tarball ?? null });
  }
  const names = new Set([...receiptReleases.values()].map(({ name }) => name));
  const scopes = [...new Set([...names].filter((name) => name.startsWith("@")).map((name) => name.slice(1, name.indexOf("/"))))].sort();
  if (receipt?.packageCount !== names.size) defect(defects, "RECEIPT_PACKAGE_COUNT", { expected: names.size, actual: receipt?.packageCount ?? null });
  if (!Array.isArray(receipt?.scopes) || JSON.stringify(receipt.scopes) !== JSON.stringify(scopes)) {
    defect(defects, "RECEIPT_SCOPES", { expected: scopes, actual: receipt?.scopes ?? null });
  }

  const metadataFiles = await filesBelow(join(root, "metadata"));
  const metadataFileStates = new Map();
  for (const file of metadataFiles) {
    const path = join(root, "metadata", file);
    const state = await inspectRegularFileUnderRoot(rootReal, path);
    metadataFileStates.set(file, state);
    if (!state || state.state !== "regular") defect(defects, "METADATA_NOT_REGULAR_UNDER_ROOT", { file });
    if (!metadataNameFromCanonicalPath(file)) defect(defects, "METADATA_FILE_LAYOUT", { file });
  }
  const metadataReleases = new Set();
  for (const file of metadataFiles) {
    if (!metadataNameFromCanonicalPath(file)) continue;
    let metadata;
    const metadataFile = await readRegularFileUnderRoot(rootReal, join(root, "metadata", file));
    if (metadataFile.state !== "regular") {
      if (metadataFileStates.get(file)?.state === "regular") defect(defects, "METADATA_NOT_REGULAR_UNDER_ROOT", { file });
      continue;
    }
    try { metadata = JSON.parse(metadataFile.contents); } catch {
      defect(defects, "METADATA_JSON", { file });
      continue;
    }
    const name = metadata?.name;
    if (!PACKAGE_NAME.test(name ?? "") || file !== `${encodeURIComponent(name)}.json`) {
      defect(defects, "METADATA_PACKAGE_IDENTITY", { file, actual: name ?? null });
      continue;
    }
    if (metadata._id !== name) defect(defects, "METADATA_ID", { name, expected: name, actual: metadata._id ?? null });
    if (!names.has(name)) defect(defects, "UNRECEIPTED_METADATA_PACKAGE", { name });
    if (!metadata?.versions || typeof metadata.versions !== "object" || Array.isArray(metadata.versions)) {
      defect(defects, "METADATA_VERSIONS", { name });
      continue;
    }
    const availableVersions = Object.keys(metadata.versions).filter((version) => VERSION.test(version));
    const expectedLatest = availableVersions.sort(versionOrder).at(-1) ?? null;
    const latest = metadata["dist-tags"]?.latest;
    if (typeof latest !== "string" || !VERSION.test(latest) || !Object.hasOwn(metadata.versions, latest) || latest !== expectedLatest) {
      defect(defects, "METADATA_DIST_TAG_LATEST", { name, expected: expectedLatest, actual: latest ?? null });
    }
    for (const [version, manifest] of Object.entries(metadata.versions)) {
      const identity = `${name}@${version}`;
      if (!VERSION.test(version) || manifest?.name !== name || manifest?.version !== version) {
        defect(defects, "METADATA_RELEASE_IDENTITY", { identity });
        continue;
      }
      metadataReleases.add(identity);
      const entry = receiptReleases.get(identity);
      if (!entry) {
        defect(defects, "UNRECEIPTED_METADATA_RELEASE", { identity });
        continue;
      }
      const expectedTarball = registry ? new URL(canonicalArtifact(name, version), registry).href : null;
      for (const field of ["tarball", "shasum", "integrity"]) {
        const expected = field === "tarball" ? expectedTarball : entry[field];
        if (manifest?.dist?.[field] !== expected) defect(defects, "METADATA_DIST_MISMATCH", { identity, field, expected: expected ?? null, actual: manifest?.dist?.[field] ?? null });
      }
      rejectLocalProtocols(defects, name, version, manifest);
    }
  }
  for (const identity of receiptReleases.keys()) {
    if (!metadataReleases.has(identity)) defect(defects, "RECEIPT_RELEASE_WITHOUT_METADATA", { identity });
  }
  const artifactFiles = await filesBelow(join(root, "tarballs"), "tarballs");
  const actualArtifacts = new Set(artifactFiles);
  for (const artifact of actualArtifacts) {
    if (!expectedArtifacts.has(artifact)) defect(defects, "UNRECEIPTED_TARBALL", { artifact });
  }
  for (const artifact of expectedArtifacts) {
    if (!actualArtifacts.has(artifact)) defect(defects, "RECEIPT_ARTIFACT_NOT_CATALOGED", { artifact });
  }
  const sorted = sortedDefects(defects);
  if (sorted.length) throw new PackageRegistrySnapshotVerificationError(sorted);
  return Object.freeze({
    type: "SemioticVoxelPackageRegistrySnapshotVerificationReport",
    version: 1,
    registry,
    packageCount: names.size,
    releaseCount: receiptReleases.size,
    scopes,
    releases: [...receiptReleases.keys()].sort(),
  });
}
