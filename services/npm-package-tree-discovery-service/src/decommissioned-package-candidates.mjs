import { listPackageManifests } from "./package-manifests.mjs";

export const DECOMMISSIONED_PACKAGE_KEYWORD = "decommissioned";

function packageIdentity(manifest) {
  return Object.freeze({
    name: typeof manifest.name === "string" ? manifest.name : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
  });
}

/**
 * Observe packages explicitly marked for decommissioning.
 *
 * This is a pure discovery boundary. It neither selects a replacement nor
 * invokes the cannibalization runbook: both require the work rail to admit a
 * package-specific job and reserve an appropriate compute provider.
 */
export async function discoverDecommissionedPackages({ root, keyword = DECOMMISSIONED_PACKAGE_KEYWORD } = {}) {
  if (typeof keyword !== "string" || keyword.length === 0) throw new TypeError("keyword is required");
  const manifests = await listPackageManifests(root);
  const candidates = manifests
    .filter(({ manifest }) => Array.isArray(manifest.keywords) && manifest.keywords.includes(keyword))
    .map(({ directory, manifestPath, manifest }) => Object.freeze({ directory, manifestPath, keyword, ...packageIdentity(manifest) }))
    .sort((a, b) => a.directory.localeCompare(b.directory));

  return Object.freeze({
    kind: "npm.decommissioned-package-candidates",
    root,
    keyword,
    candidates: Object.freeze(candidates),
  });
}
