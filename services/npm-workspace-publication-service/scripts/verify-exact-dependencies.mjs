#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  dependencySpecificationViolations,
  isExactSemver,
  packageLockDirectResolutionViolations,
  packageLockExactResolutionClosureViolations,
  packageLockRootDependencyViolations,
} from "../src/dependency-policy.mjs";
import { isVersionPublished, readRegistryPackageVersion } from "../src/registry.mjs";
import { hasPublicationSurface } from "../src/software-estate.mjs";
import { scanRepositoryManifests, scanWorkspaceManifests } from "../src/read-workspace-manifests.mjs";

const args = process.argv.slice(2);
const rootAt = args.indexOf("--root");
const root = resolve(rootAt >= 0 && args[rootAt + 1] ? args[rootAt + 1] : process.cwd());
const checkLocks = args.includes("--check-locks");
const registryAt = args.indexOf("--registry");
const registry = registryAt >= 0 && args[registryAt + 1]
  ? args[registryAt + 1]
  : "https://registry.561.group/";
const checkRegistryClosure = args.includes("--check-registry-closure");
const checkRegistry = args.includes("--check-registry") || checkRegistryClosure;
const activeOnly = args.includes("--active-only");
const activeSites = activeOnly || checkRegistry
  ? await scanWorkspaceManifests(root)
  : [];
const sites = activeOnly ? activeSites : await scanRepositoryManifests(root);
const activePaths = checkRegistry
  ? new Set(activeSites.map(({ path }) => path))
  : new Set();
const violations = [];
const dependencySites = new Map();
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

for (const site of sites) {
  if (site.manifest === null) {
    violations.push({ path: site.path, reason: "package.json is not valid JSON" });
    continue;
  }
  if (activeOnly && site.manifest.private !== true && typeof site.manifest.name === "string" && typeof site.manifest.version === "string" && !hasPublicationSurface(site.manifest)) {
    violations.push({
      path: site.path,
      field: "publication",
      name: null,
      specification: null,
      reason: "a non-private package must declare an artifact surface (exports, main, module, types, bin, or files)",
    });
  }
  for (const violation of dependencySpecificationViolations(site.manifest)) {
    violations.push({ path: site.path, ...violation });
  }
  if (activePaths.has(site.path)) {
    for (const field of dependencyFields) {
      for (const [name, specification] of Object.entries(site.manifest[field] ?? {})) {
        if (!isExactSemver(specification)) continue;
        const key = `${name}\u0000${specification}`;
        if (!dependencySites.has(key)) dependencySites.set(key, []);
        dependencySites.get(key).push({ path: site.path, field, name, specification });
      }
    }
  }
  if (checkLocks) {
    const packageLockPath = resolve(site.dir, "package-lock.json");
    try {
      const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));
      for (const violation of packageLockRootDependencyViolations(site.manifest, packageLock)) {
        violations.push({ path: packageLockPath, ...violation });
      }
      for (const violation of packageLockDirectResolutionViolations(site.manifest, packageLock)) {
        violations.push({ path: packageLockPath, ...violation });
      }
      for (const violation of packageLockExactResolutionClosureViolations(packageLock).filter(({ location }) => location !== "")) {
        violations.push({ path: packageLockPath, ...violation });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        violations.push({ path: packageLockPath, field: null, name: null, specification: null, reason: "package-lock.json is not valid JSON" });
      }
    }
  }
}

if (checkRegistry) {
  const pending = [...dependencySites.entries()];
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length > 0) {
      const [key, consumers] = pending.pop();
      const separator = key.indexOf("\u0000");
      const name = key.slice(0, separator);
      const version = key.slice(separator + 1);
      const availability = await isVersionPublished(registry, name, version);
      if (availability.published) continue;
      for (const consumer of consumers) {
        violations.push({
          ...consumer,
          reason: availability.reachable
            ? `exact dependency version is absent from registry ${registry}`
            : `dependency registry is unreachable: ${registry}`,
        });
      }
    }
  });
  await Promise.all(workers);
}

if (checkRegistryClosure) {
  const runtimeFields = ["dependencies", "optionalDependencies", "peerDependencies"];
  const ownedNames = new Set(sites.flatMap(({ manifest }) => typeof manifest?.name === "string" ? [manifest.name] : []));
  const pending = [...dependencySites.keys()];
  const visited = new Set();
  while (pending.length > 0) {
    const key = pending.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    const separator = key.indexOf("\u0000");
    const name = key.slice(0, separator);
    const version = key.slice(separator + 1);
    const result = await readRegistryPackageVersion(registry, name, version);
    if (!result.reachable || !result.found) {
      if (!dependencySites.has(key)) {
        violations.push({
          path: root,
          field: "registry-closure",
          name,
          specification: version,
          reason: result.reachable
            ? `transitive dependency version is absent from registry ${registry}`
            : `dependency registry is unreachable: ${registry}`,
        });
      }
      continue;
    }
    for (const field of runtimeFields) {
      for (const [dependency, specification] of Object.entries(result.manifest?.[field] ?? {})) {
        if (!isExactSemver(specification) && ownedNames.has(dependency)) {
          violations.push({
            path: root,
            field: `registry.${name}@${version}.${field}`,
            name: dependency,
            specification,
            reason: "published transitive dependency specification must be one exact semver",
          });
          continue;
        }
        if (isExactSemver(specification)) pending.push(`${dependency}\u0000${specification}`);
      }
    }
  }
}

for (const violation of violations) {
  const dependency = violation.name === null || violation.name === undefined
    ? violation.field ?? "manifest"
    : `${violation.field}.${violation.name}`;
  const observed = Object.hasOwn(violation, "lockSpecification")
    ? `manifest ${JSON.stringify(violation.manifestSpecification)}, lock ${JSON.stringify(violation.lockSpecification)}`
    : Object.hasOwn(violation, "resolvedVersion")
      ? `manifest ${JSON.stringify(violation.manifestSpecification)}, resolved ${JSON.stringify(violation.resolvedVersion)}`
    : JSON.stringify(violation.specification);
  process.stderr.write(`${relative(root, violation.path)}: ${dependency}: ${violation.reason}; observed ${observed}\n`);
}

if (violations.length > 0) {
  process.stderr.write(`exact dependency policy failed: ${violations.length} violation(s) in ${sites.length} package manifest(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`exact dependency policy passed: ${sites.length} package manifest(s)\n`);
}
