import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dependencySpecificationViolations,
  isExactSemver,
  packageLockRootDependencyViolations,
  resolvePackageLockDependency,
  WORKSPACE_SPECIFICATION,
} from "./dependency-policy.mjs";
import { readRegistryPackage } from "./registry.mjs";

const DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

/**
 * House scopes routed to the canonical registry, mirroring `~/.npmrc`'s
 * per-scope `registry=` lines. Any other scope, or no scope at all, is
 * third-party and resolves against the public npm registry.
 */
const HOUSE_SCOPE_REGISTRY = Object.freeze({
  "@561-group": "https://registry.561.group/",
  "@causeway-services": "https://registry.561.group/",
  "@coesite-operations": "https://registry.561.group/",
  "@emsenn": "https://registry.561.group/",
  "@lenticule-science": "https://registry.561.group/",
  "@red-cup-engineering": "https://registry.561.group/",
});
const THIRD_PARTY_REGISTRY = "https://registry.npmjs.org/";

const NON_REGISTRY_SPECIFIER = /^(?:workspace:|file:|link:|git\+|git:|github:|gitlab:|bitbucket:|https?:\/\/)/u;

/**
 * @param {string} name a dependency package name
 * @returns {string} the registry base URL that owns `name`'s scope
 */
export function registryForPackageName(name) {
  const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : null;
  return (scope && HOUSE_SCOPE_REGISTRY[scope]) || THIRD_PARTY_REGISTRY;
}

/**
 * @param {string} specification a manifest dependency specification
 * @returns {boolean} true for workspace:/file:/link:/git/URL specs, which are
 *   never rewritten by a registry-version lookup
 */
export function isNonRegistrySpecifier(specification) {
  return typeof specification === "string" && NON_REGISTRY_SPECIFIER.test(specification.trim());
}

function hasNpmPackagesGraph(packageLock) {
  return Boolean(packageLock)
    && Object.getPrototypeOf(packageLock) === Object.prototype
    && Number.isInteger(packageLock.lockfileVersion)
    && packageLock.lockfileVersion >= 2
    && packageLock.packages
    && Object.getPrototypeOf(packageLock.packages) === Object.prototype;
}

/**
 * Plan the rewrites that would make one manifest's dependency
 * specifications pass `dependencySpecificationViolations`, without
 * mutating anything. Resolution order per entry: the package's own
 * package-lock.json root resolution, then the highest registry-published
 * version satisfying the range; a workspace/file/link/git/URL specifier or
 * an otherwise-unresolvable one is refused, never rewritten.
 *
 * @param {object} manifest a parsed package.json
 * @param {{packageLock?: object|null, readRegistryPackageImpl?: Function}} [options]
 * @returns {Promise<{rewrites: Array<{field: string, name: string, from: string, to: string, source: string}>, refusals: Array<{name: string, spec: string, reason: string}>, removeFields: string[]}>}
 */
export async function planExactDependencyPins(manifest, { packageLock = null, readRegistryPackageImpl = readRegistryPackage } = {}) {
  const rewrites = [];
  const refusals = [];
  const removeFields = [];
  if (Object.hasOwn(manifest, "workspaces")) removeFields.push("workspaces");
  if (Object.hasOwn(manifest, "overrides")) removeFields.push("overrides");

  const lockUsable = hasNpmPackagesGraph(packageLock);

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!dependencies || Object.getPrototypeOf(dependencies) !== Object.prototype) continue;
    for (const [name, specification] of Object.entries(dependencies)) {
      // Exact pins and workspace siblings (workspace:*, resolved exactly at publication) are the policy's own forms.
      if (isExactSemver(specification) || specification === WORKSPACE_SPECIFICATION) continue;
      if (isNonRegistrySpecifier(specification)) {
        refusals.push({ name, spec: specification, reason: "non-registry specifier (workspace/file/link/git/URL) is never rewritten" });
        continue;
      }

      const locked = lockUsable ? resolvePackageLockDependency(packageLock, "", name) : null;
      if (typeof locked?.entry?.version === "string") {
        rewrites.push({ field, name, from: specification, to: locked.entry.version, source: "lockfile" });
        continue;
      }

      const { default: semver } = await import("semver");
      const range = semver.validRange(specification);
      if (range === null) {
        refusals.push({ name, spec: specification, reason: "specification is not a resolvable semver range" });
        continue;
      }
      const registry = registryForPackageName(name);
      const result = await readRegistryPackageImpl(registry, name);
      const versions = result.found && result.packument?.versions ? Object.keys(result.packument.versions) : null;
      if (versions === null) {
        refusals.push({ name, spec: specification, reason: result.reachable ? `package not found on registry ${registry}` : `registry unreachable: ${registry}` });
        continue;
      }
      const best = semver.maxSatisfying(versions, range);
      if (best === null) {
        refusals.push({ name, spec: specification, reason: `no version published on ${registry} satisfies the range` });
        continue;
      }
      rewrites.push({ field, name, from: specification, to: best, source: `registry:${registry}` });
    }
  }
  return { rewrites: Object.freeze(rewrites), refusals: Object.freeze(refusals), removeFields: Object.freeze(removeFields) };
}

/**
 * Apply a plan from `planExactDependencyPins` to a manifest, returning a new
 * object. Only rewritten values and removed fields change; every other
 * key's position and value are preserved.
 *
 * @param {object} manifest a parsed package.json
 * @param {{rewrites: Array<{field: string, name: string, to: string}>, removeFields: string[]}} plan
 * @returns {object} the rewritten manifest
 */
export function applyExactDependencyPinPlan(manifest, plan) {
  const next = structuredClone(manifest);
  for (const field of plan.removeFields) delete next[field];
  for (const { field, name, to } of plan.rewrites) next[field][name] = to;
  return next;
}

function synchronizePackageLockRootDependencies(manifest, packageLock) {
  if (!hasNpmPackagesGraph(packageLock)) return { packageLock, rewrites: Object.freeze([]) };
  const rewrites = packageLockRootDependencyViolations(manifest, packageLock);
  if (rewrites.length === 0) return { packageLock, rewrites };
  const next = structuredClone(packageLock);
  const root = next.packages[""];
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] === undefined) delete root[field];
    else root[field] = structuredClone(manifest[field]);
  }
  return { packageLock: next, rewrites };
}

/**
 * Deterministically repair every `dependencySpecificationViolations` finding
 * across one or more package sites: plan an exact-pin rewrite for each
 * non-exact dependency specification, and in `apply` mode write it and
 * re-run the checker as a gate. Never touches `node_modules` or runs
 * `npm install`.
 *
 * @param {{sites: Array<{path: string, dir: string, manifest: object}>, apply?: boolean, readFileImpl?: Function, writeFileImpl?: Function, readRegistryPackageImpl?: Function}} options
 * @returns {Promise<{kind: string, packages: Array<{path: string, rewrites: Array, refusals: Array, violationsAfter: number}>, ok: boolean}>}
 */
export async function pinExactDependencies({
  sites,
  apply = false,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  readRegistryPackageImpl = readRegistryPackage,
}) {
  const packages = [];
  for (const site of sites) {
    let packageLock = null;
    try {
      packageLock = JSON.parse(await readFileImpl(join(site.dir, "package-lock.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const plan = await planExactDependencyPins(site.manifest, { packageLock, readRegistryPackageImpl });
    const simulated = applyExactDependencyPinPlan(site.manifest, plan);

    const synchronized = synchronizePackageLockRootDependencies(simulated, packageLock);
    let violationsAfter;
    if (apply) {
      if (JSON.stringify(site.manifest) !== JSON.stringify(simulated)) {
        await writeFileImpl(site.path, `${JSON.stringify(simulated, null, 2)}\n`, "utf8");
      }
      if (synchronized.packageLock !== packageLock) {
        await writeFileImpl(join(site.dir, "package-lock.json"), `${JSON.stringify(synchronized.packageLock, null, 2)}\n`, "utf8");
      }
      const written = JSON.parse(await readFileImpl(site.path, "utf8"));
      const writtenLock = synchronized.packageLock === packageLock
        ? packageLock
        : JSON.parse(await readFileImpl(join(site.dir, "package-lock.json"), "utf8"));
      violationsAfter = dependencySpecificationViolations(written).length
        + (writtenLock === null ? 0 : packageLockRootDependencyViolations(written, writtenLock).length);
    } else {
      violationsAfter = dependencySpecificationViolations(simulated).length
        + (synchronized.packageLock === null ? 0 : packageLockRootDependencyViolations(simulated, synchronized.packageLock).length);
    }

    packages.push({
      path: site.path,
      rewrites: plan.rewrites,
      lockRootRewrites: synchronized.rewrites,
      refusals: plan.refusals,
      violationsAfter,
    });
  }

  const ok = !apply || packages.every((entry) => entry.violationsAfter === 0);
  return {
    kind: "npm-workspace-publication.exact-pin-repair",
    packages,
    ok,
  };
}
