import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { inspectPackedCarrierArchive } from "./packed-carrier-archive.mjs";
import { verifyArtifactBytes } from "./npm-artifact-integrity-service.mjs";

const COMPRESSED_LIMIT = 32 * 1024 * 1024;
const EXPANDED_LIMIT = 128 * 1024 * 1024;
const MANIFEST_LIMIT = 1024 * 1024;
const RUNTIME_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
const LOCAL_PROTOCOL = /^(?:workspace:|file:|link:)/u;

function refuse(code, message, cause) {
  throw Object.assign(new Error(message, { cause }), { code });
}

function dependencyMap(manifest, field) {
  if (!Object.hasOwn(manifest, field)) return {};
  const keys = manifest[field];
  if (!keys || typeof keys !== "object" || Array.isArray(keys) ||
      Object.values(keys).some(specifier => typeof specifier !== "string" || !specifier))
    refuse("INVALID_NPM_ARCHIVE_MANIFEST", `invalid ${field} dependency map`);
  return keys;
}

// npm resolves required and optional peers differently. Compare effective
// optionality of declared peers, not incidental order or explicit false.
function optionalPeerNames(manifest) {
  if (!Object.hasOwn(manifest, "peerDependenciesMeta")) return [];
  const metadata = manifest.peerDependenciesMeta;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    refuse("INVALID_NPM_ARCHIVE_MANIFEST", "invalid peerDependenciesMeta map");
  const peers = dependencyMap(manifest, "peerDependencies");
  return Object.keys(peers).filter(name => {
    if (!Object.hasOwn(metadata, name)) return false;
    const record = metadata[name];
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        (Object.hasOwn(record, "optional") && typeof record.optional !== "boolean"))
      refuse("INVALID_NPM_ARCHIVE_MANIFEST", "invalid peer dependency optionality");
    return record.optional === true;
  }).sort();
}

/**
 * Admit an exact immutable npm archive against a publisher's supplied release
 * manifest and SHA-512. No filesystem reads, extraction, install or registry
 * effects. A match proves archive agreement, not source ownership.
 */
export function admitNpmPackageArchive(bytes, { manifest, integrity } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > COMPRESSED_LIMIT)
    refuse("NPM_ARCHIVE_BOUNDS", "npm archive bytes must be a Uint8Array within the compressed size limit");
  if (!manifest || typeof manifest.name !== "string" || !manifest.name ||
      typeof manifest.version !== "string" || !manifest.version || typeof integrity !== "string")
    refuse("INVALID_NPM_ARCHIVE_MANIFEST", "exact package, version and integrity claims are required");
  const { ok, measurement } = verifyArtifactBytes(bytes, { integrity });
  if (!ok) refuse("NPM_ARCHIVE_INTEGRITY_MISMATCH", "npm archive SHA-512 does not match the supplied release");
  let embedded;
  try {
    const expanded = gunzipSync(bytes, { maxOutputLength: EXPANDED_LIMIT });
    const archive = inspectPackedCarrierArchive(expanded, {
      members: 65536, bytes: EXPANDED_LIMIT, tarBytes: EXPANDED_LIMIT, metadataBytes: MANIFEST_LIMIT,
    }, { profile: "npm-gzip-tar-v1" });
    if (Buffer.byteLength(archive.manifestText) > MANIFEST_LIMIT)
      throw new Error("npm package manifest exceeds the admission bound");
    embedded = JSON.parse(archive.manifestText);
  } catch (cause) {
    refuse("INVALID_NPM_ARCHIVE_MANIFEST", "npm archive could not supply a unique bounded manifest", cause);
  }
  if (embedded?.name !== manifest.name || embedded.version !== manifest.version)
    refuse("NPM_ARCHIVE_IDENTITY_MISMATCH", "npm archive package or version differs from the supplied release");
  for (const field of [...RUNTIME_FIELDS, "devDependencies"]) {
    const supplied = dependencyMap(manifest, field);
    const observed = dependencyMap(embedded, field);
    if ([...Object.values(supplied), ...Object.values(observed)].some(value => LOCAL_PROTOCOL.test(value)))
      refuse("NPM_ARCHIVE_LOCAL_PROTOCOL", `npm archive release contains a local dependency in ${field}`);
    if (field !== "devDependencies" && !isDeepStrictEqual(supplied, observed))
      refuse("NPM_ARCHIVE_DEPENDENCY_MISMATCH", `npm archive disagrees with the supplied release in ${field}`);
  }
  if (!isDeepStrictEqual(optionalPeerNames(manifest), optionalPeerNames(embedded)))
    refuse("NPM_ARCHIVE_DEPENDENCY_MISMATCH", "npm archive disagrees with the supplied release in optional peer dependencies");
  return Object.freeze({ name: embedded.name, version: embedded.version, measurement });
}
