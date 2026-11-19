import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SNAPSHOT_DEMAND = "PackageRegistrySnapshotDemand";

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

async function declaredOperationGraph(entry, registryRoot, recordSha256) {
  const recordDeclarations = objectDeclarations(entry);
  if (Object.keys(recordDeclarations).length > 0) {
    return {
      declarations: recordDeclarations,
      evidence: Object.freeze({ source: "registry-receipt", sha256: recordSha256 }),
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
        sha256: `sha256:${createHash("sha256").update(metadataBytes).digest("hex")}`,
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
  if (typeof demand.requestId !== "string" || demand.requestId.trim() === "") throw new TypeError("snapshot demand requires requestId");
  const registry = registryOrigin(registryUrl);
  if (demand.registry !== registry) throw new Error("snapshot demand must name this exact private registry face");
  const root = resolve(registryRoot);
  const recordBytes = await readFile(join(root, "registry-receipt.json"));
  const record = JSON.parse(recordBytes.toString("utf8"));
  if (record?.type !== "PackageRegistryReceipt" || !Array.isArray(record.packages) || !Array.isArray(record.scopes)) {
    throw new Error("registry has no recognized snapshot receipt");
  }
  if (record.version !== undefined && record.version !== 1 && record.version !== 2) {
    throw new Error(`unsupported package registry receipt version: ${record.version}`);
  }
  const recordSha256 = `sha256:${createHash("sha256").update(recordBytes).digest("hex")}`;
  const packages = await Promise.all(record.packages.map(async (entry) => {
    const { name, version, artifact, bytes, shasum, integrity } = entry;
    const { declarations, evidence } = await declaredOperationGraph(entry, root, recordSha256);
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
    receiptSha256: recordSha256,
    packages,
    scopes: Object.freeze([...record.scopes]),
    npmrc: scopedConfig(record.scopes, registry),
  });
}
