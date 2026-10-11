import { dependencySpecificationViolations, packageLockRootIdentityViolations } from "./dependency-policy.mjs";
import { classifyReleaseVersion } from "./release-wave.mjs";

const CARRIER_FIELDS = new Set([
  "version", "private", "type", "main", "module", "types", "exports", "imports",
  "bin", "files", "scripts", "dependencies", "devDependencies", "optionalDependencies",
  "peerDependencies", "peerDependenciesMeta", "engines", "publishConfig", "license",
]);

/**
 * A named section record may explain a directory without being an npm carrier.
 * A carrier owns executable/package-facing fields and therefore needs a release
 * identity even when it is private.
 */
export function manifestRole(manifest) {
  if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype) return "invalid";
  if (Object.keys(manifest).some((field) => CARRIER_FIELDS.has(field))) return "carrier";
  return typeof manifest.name === "string" && manifest.name !== "" ? "section-metadata" : "metadata";
}

export function semanticVersionPolicyViolations(manifest, packageLock) {
  const role = manifestRole(manifest);
  if (role === "metadata" || role === "section-metadata") return Object.freeze([]);
  if (role === "invalid") {
    return Object.freeze([{ field: null, reason: "manifest is not a JSON object" }]);
  }

  const violations = [];
  if (typeof manifest.name !== "string" || manifest.name === "") {
    violations.push({ field: "name", reason: "carrier manifest requires a nonempty package name" });
  }
  if (typeof manifest.version !== "string" || manifest.version === "") {
    violations.push({ field: "version", reason: "carrier manifest requires a stable X.Y.Z or development X.Y.Z-tag.N version" });
  } else {
    try {
      const release = classifyReleaseVersion(manifest.version);
      if (release.major >= 1) violations.push({ field: "version", value: manifest.version, reason: "house package versions must remain below 1.0.0" });
    } catch (error) {
      violations.push({ field: "version", value: manifest.version, reason: String(error.message ?? error) });
    }
  }
  violations.push(...dependencySpecificationViolations(manifest));
  if (packageLock !== undefined) violations.push(...packageLockRootIdentityViolations(manifest, packageLock));
  return Object.freeze(violations.map(Object.freeze));
}
