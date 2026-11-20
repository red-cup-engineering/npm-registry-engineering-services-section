import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Digest, sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

const SNAPSHOT_DEMAND = "PackageRegistrySnapshotDemand";
const SCOPED_PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function receiptEntry(entry, index) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`registry receipt package ${index} must be an object`);
  }
  const name = requiredString(entry.name, `registry receipt package ${index} name`);
  const version = requiredString(entry.version, `registry receipt package ${index} version`);
  const artifact = requiredString(entry.artifact, `registry receipt package ${index} artifact`);
  const shasum = requiredString(entry.shasum, `registry receipt package ${index} shasum`);
  const integrity = requiredString(entry.integrity, `registry receipt package ${index} integrity`);
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    throw new TypeError(`registry receipt package ${index} bytes must be a non-negative safe integer`);
  }
  if (!SCOPED_PACKAGE_NAME.test(name)) {
    throw new TypeError(`registry receipt package ${index} name must be a scoped npm package name`);
  }
  if (!EXACT_VERSION.test(version)) {
    throw new TypeError(`registry receipt package ${index} version must be an exact version`);
  }
  const [, scope, leaf] = /^@([^/]+)\/([^/]+)$/u.exec(name);
  const expectedArtifact = `tarballs/${scope}/${leaf}/-/${leaf}-${version}.tgz`;
  if (artifact !== expectedArtifact) {
    throw new TypeError(`registry receipt package ${index} artifact must exactly match its package coordinates`);
  }
  return { ...entry, name, version, artifact, bytes: entry.bytes, shasum, integrity };
}

function receiptScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string" || scope.trim() === "")) {
    throw new TypeError("registry receipt scopes must be non-empty strings");
  }
  if (new Set(scopes).size !== scopes.length) throw new TypeError("registry receipt scopes must not repeat");
  return Object.freeze([...scopes]);
}

function registryOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("registry URL must be HTTP(S)");
  return url.href;
}

function scopedConfig(scopes, registry) {
  return ["registry=https://registry.npmjs.org/", ...scopes.map((scope) => `@${scope}:registry=${registry}`), ""].join("\n");
}

function objectDeclarations(source) {
  const declarations = {};
  for (const field of ["x-semiotic-voxel", "x-agentic-metro-enterprise"]) {
    const declaration = source?.[field];
    if (declaration !== null && typeof declaration === "object" && !Array.isArray(declaration)) {
      declarations[field] = structuredClone(declaration);
    }
  }
  return declarations;
}

async function declaredOperationGraph(entry, registryRoot, receiptSha256) {
  const receiptDeclarations = objectDeclarations(entry);
  if (Object.keys(receiptDeclarations).length > 0) {
    return {
      declarations: receiptDeclarations,
      evidence: Object.freeze({ source: "registry-receipt", sha256: receiptSha256 }),
    };
  }
  try {
    const metadataBytes = await readFile(join(registryRoot, "metadata", `${encodeURIComponent(entry.name)}.json`));
    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    const version = metadata.versions?.[entry.version];
    if (metadata.name !== entry.name || version?.name !== entry.name || version?.version !== entry.version) {
      throw new Error(`package metadata identity does not match registry receipt: ${entry.name}@${entry.version}`);
    }
    if (version.dist?.integrity !== entry.integrity || version.dist?.shasum !== entry.shasum) {
      throw new Error(`package metadata artifact does not match registry receipt: ${entry.name}@${entry.version}`);
    }
    return {
      declarations: objectDeclarations(version),
      evidence: Object.freeze({
        source: "npm-version-metadata",
        sha256: sha256Digest(metadataBytes),
        artifactIntegrity: entry.integrity,
      }),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { declarations: {}, evidence: null };
}

export async function obtainRegistrySnapshot(demand, { registryRoot, registryUrl }) {
  if (demand?.type !== SNAPSHOT_DEMAND) throw new TypeError("one PackageRegistrySnapshotDemand is required");
  requiredString(demand.requestId, "snapshot demand requestId");
  requiredString(registryRoot, "registry root");
  const registry = registryOrigin(registryUrl);
  if (demand.registry !== registry) throw new Error("snapshot demand must name this exact private registry face");
  const root = resolve(registryRoot);
  const receiptBytes = await readFile(join(root, "registry-receipt.json"));
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  if (receipt?.type !== "SemioticVoxelPackageRegistryReceipt" || !Array.isArray(receipt.packages) || !Array.isArray(receipt.scopes)) {
    throw new Error("registry has no recognized snapshot receipt");
  }
  if (receipt.version !== 2) {
    throw new Error(`unsupported package registry receipt version: ${receipt.version}`);
  }
  const scopes = receiptScopes(receipt.scopes);
  const entries = receipt.packages.map(receiptEntry);
  const names = entries.map((entry) => `${entry.name}@${entry.version}`);
  if (new Set(names).size !== names.length) throw new TypeError("registry receipt packages must not repeat name and version");
  const receiptSha256 = sha256Digest(receiptBytes);
  const packages = await Promise.all(entries.map(async (entry) => {
    const { name, version, artifact, bytes, shasum, integrity } = entry;
    const { declarations, evidence } = await declaredOperationGraph(entry, root, receiptSha256);
    return Object.freeze({
      name,
      version,
      artifact,
      bytes,
      shasum,
      integrity,
      tarball: new URL(artifact, registry).href,
      ...declarations,
      ...(evidence === null ? {} : { declarationEvidence: evidence }),
    });
  }));
  return Object.freeze({
    type: "PackageRegistrySnapshot",
    requestId: demand.requestId,
    registry,
    receiptSha256,
    packages,
    scopes,
    npmrc: scopedConfig(scopes, registry),
  });
}
