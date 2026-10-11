import { semanticId } from "@red-cup-engineering/computer-content-address-engineering-services-section/semiotic-content-address";

function inventory(value, name) {
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || path === "")) {
    throw new TypeError(`${name} must be an array of nonempty paths`);
  }
  return Object.freeze([...new Set(value)].sort());
}

function difference(left, right) {
  const rightSet = new Set(right);
  return Object.freeze(left.filter((value) => !rightSet.has(value)));
}

function manifestIdentity(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
    || typeof manifest.name !== "string" || manifest.name === ""
    || typeof manifest.version !== "string" || manifest.version === "") {
    throw new TypeError("artifact manifest must name a package and immutable version");
  }
  return semanticId(manifest);
}

/**
 * Admit the one immutable npm release artifact that a consumer may promote.
 *
 * The source contract, registry tarball, installed package root, and every
 * declared JavaScript import are evidence about the same (registry, name,
 * version) release identity.  The caller owns effects; this model only makes
 * the comparison and its refusal replayable.
 */
export function admitArtifactRelease({ registry, manifest, tarballManifest, tarballInventory, installedManifest, installedInventory, imports } = {}) {
  if (typeof registry !== "string" || registry === "") throw new TypeError("registry is required");
  const sourceManifestIdentity = manifestIdentity(manifest);
  const tarballManifestIdentity = manifestIdentity(tarballManifest);
  const installedManifestIdentity = manifestIdentity(installedManifest);
  const packed = inventory(tarballInventory, "tarballInventory");
  const installed = inventory(installedInventory, "installedInventory");
  if (!Array.isArray(imports) || imports.some((entry) => !entry || typeof entry.specifier !== "string" || entry.specifier === "" || entry.status !== "imported" || !Array.isArray(entry.exports))) {
    throw new TypeError("imports must record each declared export as imported");
  }
  const releaseIdentity = semanticId(Object.freeze({
    type: "ArtifactRelease",
    version: 1,
    registry,
    package: manifest.name,
    releaseVersion: manifest.version,
    manifest: sourceManifestIdentity,
  }));
  const refusal = Object.freeze({
    manifestMismatch: sourceManifestIdentity !== tarballManifestIdentity || sourceManifestIdentity !== installedManifestIdentity,
    inventory: Object.freeze({
      absentFromTarball: difference(installed, packed),
      absentFromInstalledPackage: difference(packed, installed),
    }),
  });
  if (tarballManifest.name !== manifest.name || tarballManifest.version !== manifest.version
    || installedManifest.name !== manifest.name || installedManifest.version !== manifest.version
    || refusal.manifestMismatch || refusal.inventory.absentFromTarball.length > 0 || refusal.inventory.absentFromInstalledPackage.length > 0) {
    return Object.freeze({ ok: false, refusal: Object.freeze({ code: "artifact-release-mismatch", releaseIdentity, ...refusal }) });
  }
  return Object.freeze({ ok: true, value: Object.freeze({
    type: "ArtifactRelease",
    version: 1,
    identity: releaseIdentity,
    registry,
    package: manifest.name,
    releaseVersion: manifest.version,
    manifest: Object.freeze({ identity: sourceManifestIdentity, value: manifest }),
    tarball: Object.freeze({ manifestIdentity: tarballManifestIdentity, inventory: packed }),
    installed: Object.freeze({ manifestIdentity: installedManifestIdentity, inventory: installed }),
    imports: Object.freeze(imports.map((entry) => Object.freeze({ specifier: entry.specifier, status: entry.status, exports: Object.freeze([...entry.exports].sort()) }))),
  }) });
}
