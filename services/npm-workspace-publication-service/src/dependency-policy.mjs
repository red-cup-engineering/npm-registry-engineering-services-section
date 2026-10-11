const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isExactSemver(value) {
  return typeof value === "string" && EXACT_SEMVER.test(value);
}

/**
 * A source manifest names a sibling in this workspace as `workspace:*` (pnpm's workspace protocol):
 * the sibling itself, whatever version it carries, so a sibling's release never strands the packages
 * that use it. Every published contract still names one exact version: `publicationManifest`
 * resolves each `workspace:*` to the sibling's version when a package leaves the workspace.
 */
export const WORKSPACE_SPECIFICATION = "workspace:*";

/** The exact version a source specification of `name` names: itself when exact; a sibling's version for `workspace:*`; else null. */
export function resolvedDependencyVersion(name, specification, versionOf) {
  if (isExactSemver(specification)) return specification;
  if (specification !== WORKSPACE_SPECIFICATION) return null;
  const version = versionOf(name);
  if (!isExactSemver(version)) throw new Error(`${name} is named as a workspace sibling but no workspace package of that name carries an exact version`);
  return version;
}

/** The manifest a package is published with: every `workspace:*` resolved to its sibling's exact version. */
export function publicationManifest(manifest, versionOf) {
  const published = structuredClone(manifest);
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, specification] of Object.entries(published[field] ?? {})) {
      if (specification === WORKSPACE_SPECIFICATION) published[field][name] = resolvedDependencyVersion(name, specification, versionOf);
    }
  }
  return published;
}

/**
 * A manifest's dependency specifications against the house policy: each names one exact semver, or,
 * in a source manifest (not `published`), a workspace sibling as `workspace:*`. A published contract
 * names exact versions only.
 */
export function dependencySpecificationViolations(manifest, { published = false } = {}) {
  const violations = [];
  if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype) {
    return Object.freeze([{ field: null, name: null, specification: null, reason: "manifest is not a JSON object" }]);
  }
  if (Object.hasOwn(manifest, "workspaces")) {
    violations.push({ field: "workspaces", name: null, specification: manifest.workspaces, reason: "package manifests must not declare workspace membership" });
  }
  if (Object.hasOwn(manifest, "overrides")) {
    violations.push({ field: "overrides", name: null, specification: manifest.overrides, reason: "package manifests must not rewrite another package's published dependency contract" });
  }
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!dependencies || Object.getPrototypeOf(dependencies) !== Object.prototype) {
      violations.push({ field, name: null, specification: dependencies, reason: `${field} must be an object` });
      continue;
    }
    for (const [name, specification] of Object.entries(dependencies)) {
      if (specification === WORKSPACE_SPECIFICATION && !published) continue;
      if (!isExactSemver(specification)) {
        violations.push({ field, name, specification, reason: published ? "a published dependency specification must be one exact semver" : "dependency specification must be one exact semver or a workspace sibling (workspace:*)" });
      } else if (isExactSemver(manifest.version) && !/^\d+\.\d+\.\d+-/u.test(manifest.version) && /^\d+\.\d+\.\d+-/u.test(specification)) {
        violations.push({ field, name, specification, reason: "a stable package must not depend on a prerelease package" });
      }
    }
  }
  return Object.freeze(violations.map(Object.freeze));
}

export function packageLockRootDependencyViolations(manifest, packageLock) {
  if (!packageLock || Object.getPrototypeOf(packageLock) !== Object.prototype) {
    return Object.freeze([{ field: null, name: null, manifestSpecification: null, lockSpecification: null, reason: "package-lock.json is not a JSON object" }]);
  }
  const lockRoot = packageLock.packages?.[""];
  if (!lockRoot || Object.getPrototypeOf(lockRoot) !== Object.prototype) {
    return Object.freeze([{ field: null, name: null, manifestSpecification: null, lockSpecification: null, reason: "package-lock.json has no packages[\"\"] root record" }]);
  }

  const violations = [];
  for (const field of DEPENDENCY_FIELDS) {
    const manifestDependencies = manifest?.[field] ?? {};
    const lockDependencies = lockRoot[field] ?? {};
    const names = new Set([
      ...Object.keys(manifestDependencies),
      ...Object.keys(lockDependencies),
    ]);
    for (const name of [...names].sort()) {
      const manifestSpecification = manifestDependencies[name];
      const lockSpecification = lockDependencies[name];
      if (manifestSpecification !== lockSpecification) {
        violations.push({
          field,
          name,
          manifestSpecification,
          lockSpecification,
          reason: "package-lock root specification must equal package.json",
        });
      }
    }
  }
  return Object.freeze(violations.map(Object.freeze));
}

export function packageLockRootIdentityViolations(manifest, packageLock) {
  if (!packageLock || Object.getPrototypeOf(packageLock) !== Object.prototype) {
    return Object.freeze([{ field: null, manifestValue: null, lockValue: null, reason: "package-lock.json is not a JSON object" }]);
  }
  const lockRoot = packageLock.packages?.[""];
  if (!lockRoot || Object.getPrototypeOf(lockRoot) !== Object.prototype) {
    return Object.freeze([{ field: null, manifestValue: null, lockValue: null, reason: "package-lock.json has no packages[\"\"] root record" }]);
  }
  const violations = [];
  for (const field of ["name", "version"]) {
    if (lockRoot[field] !== manifest?.[field]) {
      violations.push({
        field,
        manifestValue: manifest?.[field],
        lockValue: lockRoot[field],
        reason: `package-lock root ${field} must equal package.json`,
      });
    }
  }
  return Object.freeze(violations.map(Object.freeze));
}

/**
 * An npm v2/v3 lock repeats each direct dependency twice: once as a root
 * specification and once as the selected node_modules entry. Both assertions
 * must agree with the manifest. Checking only the root copy admits a stale
 * resolution left behind by a partial or hand-written lock update.
 */
export function packageLockDirectResolutionViolations(manifest, packageLock) {
  if (!packageLock || Object.getPrototypeOf(packageLock) !== Object.prototype) {
    return Object.freeze([{ field: null, name: null, manifestSpecification: null, resolvedVersion: null, reason: "package-lock.json is not a JSON object" }]);
  }
  if (!Number.isInteger(packageLock.lockfileVersion) || packageLock.lockfileVersion < 2 || !packageLock.packages || Object.getPrototypeOf(packageLock.packages) !== Object.prototype) {
    return Object.freeze([{ field: null, name: null, manifestSpecification: null, resolvedVersion: null, reason: "direct resolution assay requires an npm v2/v3 packages graph" }]);
  }

  const violations = [];
  for (const { field, name, specification: manifestSpecification, optional } of effectiveDependencyEdges(manifest, { root: true })) {
    if (!isExactSemver(manifestSpecification)) continue;
    const resolved = resolveLockedDependency(packageLock.packages, "", name);
    const admitted = dereferenceLockedDependency(packageLock.packages, resolved);
    const resolvedVersion = admitted.entry?.version;
    if (optional && resolved === null) continue;
    if (resolved?.entry?.link === true && admitted.entry?.name !== name) {
      violations.push({
        field,
        name,
        manifestSpecification,
        resolvedVersion,
        reason: "package-lock link target identity must equal dependency name",
      });
      continue;
    }
    if (resolvedVersion !== manifestSpecification) {
      violations.push({
        field,
        name,
        manifestSpecification,
        resolvedVersion,
        reason: admitted.reason ?? (resolvedVersion === undefined
          ? "package-lock graph has no direct resolution for the exact dependency"
          : "package-lock direct resolution must equal package.json"),
      });
    }
  }
  return Object.freeze(violations.map(Object.freeze));
}

const LOCK_ROOT = "/__npm_lock_root__";

function lockAbsoluteLocation(location) {
  return location === "" ? LOCK_ROOT : path.posix.resolve(LOCK_ROOT, location);
}

function lockRelativeLocation(absolute) {
  const relative = path.posix.relative(LOCK_ROOT, absolute);
  return relative === "." ? "" : relative;
}

function resolveLockedDependency(packages, location, name) {
  for (let directory = lockAbsoluteLocation(location);;) {
    if (path.posix.basename(directory) !== "node_modules") {
      const candidate = lockRelativeLocation(path.posix.join(directory, "node_modules", name));
      if (Object.hasOwn(packages, candidate)) return { location: candidate, entry: packages[candidate] };
    }
    const parent = path.posix.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function dereferenceLockedDependency(packages, resolved) {
  if (resolved === null) return { location: null, entry: null, reason: null };
  let current = resolved;
  const visited = new Set();
  while (current.entry?.link === true) {
    if (visited.has(current.location)) {
      return { location: current.location, entry: null, reason: "package-lock link cycle has no admitted target" };
    }
    visited.add(current.location);
    if (typeof current.entry.resolved !== "string" || current.entry.resolved === "") {
      return { location: current.location, entry: null, reason: "package-lock link has no resolved target" };
    }
    const target = path.posix.normalize(current.entry.resolved).replace(/^\.\//u, "");
    if (!Object.hasOwn(packages, target)) {
      return { location: target, entry: null, reason: "package-lock link target is absent" };
    }
    if (packages[target]?.link === true) {
      return { location: target, entry: null, reason: "package-lock link target must be a non-link package record" };
    }
    current = { location: target, entry: packages[target] };
  }
  return { ...current, reason: null };
}

function effectiveDependencyEdges(entry, { root = false } = {}) {
  const edges = new Map();
  for (const [name, specification] of Object.entries(entry.peerDependencies ?? {})) {
    edges.set(name, {
      field: "peerDependencies",
      name,
      specification,
      optional: entry.peerDependenciesMeta?.[name]?.optional === true,
    });
  }
  for (const [name, specification] of Object.entries(entry.dependencies ?? {})) {
    edges.set(name, { field: "dependencies", name, specification, optional: false });
  }
  for (const [name, specification] of Object.entries(entry.optionalDependencies ?? {})) {
    edges.set(name, { field: "optionalDependencies", name, specification, optional: true });
  }
  if (root) {
    for (const [name, specification] of Object.entries(entry.devDependencies ?? {})) {
      edges.set(name, { field: "devDependencies", name, specification, optional: false });
    }
  }
  return [...edges.values()];
}

export function effectivePackageDependencyEdges(entry, options = {}) {
  return Object.freeze(effectiveDependencyEdges(entry, options).map((edge) => Object.freeze({ ...edge })));
}

export function resolvePackageLockDependency(packageLock, location, name) {
  if (!packageLock?.packages || Object.getPrototypeOf(packageLock.packages) !== Object.prototype) {
    throw new TypeError("packageLock must carry an npm packages graph");
  }
  const selected = resolveLockedDependency(packageLock.packages, location, name);
  const admitted = dereferenceLockedDependency(packageLock.packages, selected);
  return Object.freeze({
    selectedLocation: selected?.location ?? null,
    selectedEntry: selected?.entry ?? null,
    location: admitted.location,
    entry: admitted.entry,
    reason: admitted.reason,
  });
}

function isLocalPeerResolution(ownerLocation, resolvedLocation, name) {
  if (ownerLocation === "" || resolvedLocation === null) return false;
  if (!(ownerLocation.startsWith("node_modules/") || ownerLocation.includes("/node_modules/"))) return false;
  return resolvedLocation === `${ownerLocation}/node_modules/${name}`;
}

function closureViolation({ location, field, name, specification, resolvedLocation = null, resolvedVersion, reason }) {
  return { location, field, name, specification, resolvedLocation, resolvedVersion, reason };
}

function enqueueReachable(queue, admitted, selected, edge, ownerLocation, violations) {
  if (admitted.entry === null) return;
  if (selected?.entry?.extraneous === true || admitted.entry.extraneous === true) {
    violations.push(closureViolation({
      location: ownerLocation,
      field: edge.field,
      name: edge.name,
      specification: edge.specification,
      resolvedLocation: admitted.location,
      resolvedVersion: admitted.entry.version,
      reason: "reachable package-lock entry must not be extraneous",
    }));
  }
  queue.push(admitted.location);
}

export function packageLockExactResolutionClosureViolations(packageLock) {
  if (!packageLock || Object.getPrototypeOf(packageLock) !== Object.prototype || !Number.isInteger(packageLock.lockfileVersion) || packageLock.lockfileVersion < 2 || !packageLock.packages || Object.getPrototypeOf(packageLock.packages) !== Object.prototype) {
    return Object.freeze([{ location: null, field: null, name: null, specification: null, resolvedLocation: null, resolvedVersion: null, reason: "exact resolution closure requires an npm v2/v3 packages graph" }]);
  }
  if (!packageLock.packages[""] || Object.getPrototypeOf(packageLock.packages[""]) !== Object.prototype) {
    return Object.freeze([{ location: null, field: null, name: null, specification: null, resolvedLocation: null, resolvedVersion: null, reason: "exact resolution closure requires a packages[\"\"] root record" }]);
  }
  const violations = [];
  const visited = new Set();
  const queue = [""];
  while (queue.length > 0) {
    const location = queue.shift();
    if (visited.has(location)) continue;
    visited.add(location);
    const entry = packageLock.packages[location];
    if (!entry || Object.getPrototypeOf(entry) !== Object.prototype) continue;
    for (const edge of effectiveDependencyEdges(entry, { root: location === "" })) {
      const resolved = resolveLockedDependency(packageLock.packages, location, edge.name);
      const admitted = dereferenceLockedDependency(packageLock.packages, resolved);
      const resolvedVersion = admitted.entry?.version;
      if (admitted.entry === null) {
        if (!(edge.optional && resolved === null)) violations.push(closureViolation({
          location,
          field: edge.field,
          name: edge.name,
          specification: edge.specification,
          resolvedLocation: admitted.location,
          resolvedVersion,
          reason: admitted.reason ?? "dependency edge has no Node-resolvable lock entry",
        }));
        continue;
      }
      if (resolved?.entry?.link === true && admitted.entry.name !== edge.name) {
        violations.push(closureViolation({
          location,
          field: edge.field,
          name: edge.name,
          specification: edge.specification,
          resolvedLocation: admitted.location,
          resolvedVersion,
          reason: "package-lock link target identity must equal dependency name",
        }));
      }
      if (edge.field === "peerDependencies" && isLocalPeerResolution(location, resolved?.location ?? null, edge.name)) {
        violations.push(closureViolation({
          location,
          field: edge.field,
          name: edge.name,
          specification: edge.specification,
          resolvedLocation: admitted.location,
          resolvedVersion,
          reason: "peer dependency must resolve beside or above its dependent",
        }));
      } else if (isExactSemver(edge.specification) && resolvedVersion !== edge.specification) {
        violations.push(closureViolation({
          location,
          field: edge.field,
          name: edge.name,
          specification: edge.specification,
          resolvedLocation: admitted.location,
          resolvedVersion,
          reason: "Node-resolved lock entry version must equal the exact dependency edge",
        }));
      }
      enqueueReachable(queue, admitted, resolved, edge, location, violations);
    }
  }
  return Object.freeze(violations.map(Object.freeze));
}

export function packageLockRegistryCarrierViolations(packageLock) {
  if (!packageLock?.packages || Object.getPrototypeOf(packageLock.packages) !== Object.prototype) return Object.freeze([]);
  return Object.freeze(Object.entries(packageLock.packages)
    .filter(([, entry]) => entry?.link === true)
    .map(([location, entry]) => Object.freeze({
      location,
      resolved: entry.resolved,
      reason: "publication package-lock selections must be immutable registry artifacts, not filesystem links",
    })));
}

export function dependencyContractViolations(manifest, packageLock, { requiredDependencies = [] } = {}) {
  if (!Array.isArray(requiredDependencies) || requiredDependencies.some((name) => typeof name !== "string" || name === "")) {
    throw new TypeError("requiredDependencies must be package-name strings");
  }
  const violations = [
    ...dependencySpecificationViolations(manifest),
    ...packageLockRootIdentityViolations(manifest, packageLock),
    ...packageLockRootDependencyViolations(manifest, packageLock),
    ...packageLockDirectResolutionViolations(manifest, packageLock),
    ...packageLockExactResolutionClosureViolations(packageLock).filter(({ location }) => location !== ""),
    ...packageLockRegistryCarrierViolations(packageLock),
  ];
  for (const name of [...new Set(requiredDependencies)].sort()) {
    if (!Object.hasOwn(manifest?.dependencies ?? {}, name)) {
      violations.push({
        field: "dependencies",
        name,
        specification: undefined,
        reason: "semantically required runtime dependency is absent",
      });
    }
  }
  return Object.freeze(violations.map(Object.freeze));
}
import path from "node:path";
