import semver from "semver";

const DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

function isObject(value) { return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype; }
function parsed(version) {
  const value = semver.parse(version);
  if (!value) throw new TypeError(`version reset requires exact SemVer: ${version}`);
  return value;
}
function resettable(version) { return parsed(version).major >= 1; }
function baseOf(version) {
  const value = parsed(version);
  return `${value.major}.${value.minor}.${value.patch}`;
}
function suffixOf(version) {
  const value = parsed(version);
  return (value.prerelease.length === 0 ? "" : `-${value.prerelease.join(".")}`) + (value.build.length ? `+${value.build.join(".")}` : "");
}
function sortedVersions(versions) { return [...new Set(versions)].sort(semver.compare); }

/**
 * Make one collision-free 0.x namespace for the supplied historical package
 * identities.  A base and all of its prereleases remain together: 1.2.3 and
 * 1.2.3-rc.0 become one new 0.N.0 base and 0.N.0-rc.0 respectively.
 */
export function planZeroMajorVersionMap(versions) {
  const all = sortedVersions(versions);
  const occupied = new Set(all.filter((version) => !resettable(version)));
  const bases = sortedVersions([...new Set(all.filter(resettable).map(baseOf))]);
  let minor = Math.max(-1, ...all.filter((version) => !resettable(version)).map((version) => parsed(version).minor));
  const baseTargets = new Map();
  for (const sourceBase of bases) {
    let target;
    do { target = `0.${++minor}.0`; } while (occupied.has(target));
    baseTargets.set(sourceBase, target);
    occupied.add(target);
  }
  return Object.freeze(all.filter(resettable).map((from) => Object.freeze({ from, to: `${baseTargets.get(baseOf(from))}${suffixOf(from)}` })));
}

export function rewriteVersionReference(name, specification, maps) {
  if (typeof specification !== "string") return specification;
  if (specification.startsWith("npm:")) {
    const match = /^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/u.exec(specification);
    if (match) return `npm:${match[1]}@${rewriteVersionReference(match[1], match[2], maps)}`;
  }
  const map = maps.get(name);
  if (!map?.size) return specification;
  if (map.has(specification)) return map.get(specification);
  if (semver.validRange(specification) && /(?:^|[~^<>= |])(?:[1-9][0-9]*)\./u.test(specification)) {
    const selected = semver.maxSatisfying([...map.keys()], specification);
    if (selected) return map.get(selected);
  }
  return specification;
}

function rewriteDependencies(record, maps) {
  const changed = [];
  for (const field of DEPENDENCY_FIELDS) for (const [name, version] of Object.entries(record[field] ?? {})) {
    const replacement = rewriteVersionReference(name, version, maps);
    if (replacement !== version) { record[field][name] = replacement; changed.push({ field, name, from: version, to: replacement }); }
  }
  return changed;
}

function rewriteOverrides(value, maps, changed = []) {
  if (!isObject(value)) return changed;
  for (const [name, child] of Object.entries(value)) {
    if (typeof child === "string") {
      const replacement = rewriteVersionReference(name, child, maps);
      if (replacement !== child) { value[name] = replacement; changed.push({ field: "overrides", name, from: child, to: replacement }); }
    } else rewriteOverrides(child, maps, changed);
  }
  return changed;
}

/** Rewrite only package-bearing fields; arbitrary prose and source bytes stay untouched. */
export function rewriteZeroMajorCarrier({ manifest, packageLock }, maps, { artifacts = new Map() } = {}) {
  const nextManifest = structuredClone(manifest), nextLock = packageLock === undefined ? undefined : structuredClone(packageLock);
  const identity = maps.get(nextManifest.name)?.get(nextManifest.version);
  const dependencyEdits = rewriteDependencies(nextManifest, maps);
  dependencyEdits.push(...rewriteOverrides(nextManifest.overrides, maps));
  if (identity !== undefined) nextManifest.version = identity;
  const invalidatedLockArtifacts = [];
  if (isObject(nextLock)) {
    nextLock.version = nextManifest.version;
    for (const [location, record] of Object.entries(nextLock.packages ?? {})) {
      if (!isObject(record)) continue;
      const name = record.name ?? (location === "" ? manifest.name : location.split("node_modules/").at(-1));
      const originalVersion = record.version;
      const replacement = maps.get(name)?.get(originalVersion);
      if (replacement !== undefined) {
        record.version = replacement;
        // An npm tarball embeds package.json.  Its historical hash and URL can
        // never attest to the rewritten identity; the existing reconciler must
        // regenerate them from the new publication.
        if (record.integrity !== undefined || record.resolved !== undefined) invalidatedLockArtifacts.push(location);
        delete record.integrity;
        delete record.resolved;
      }
      const artifact = artifacts.get(`${name}\u0000${originalVersion}`);
      if (artifact && location !== "") { record.version = artifact.version; record.resolved = artifact.tarball; record.integrity = artifact.integrity; }
      dependencyEdits.push(...rewriteDependencies(record, maps));
    }
    const legacy = (dependencies) => { for (const [name, record] of Object.entries(dependencies ?? {})) {
      if (!isObject(record)) continue;
      const from = record.version, to = maps.get(name)?.get(from), artifact = artifacts.get(`${name}\u0000${from}`);
      if (to) { record.version = to; delete record.resolved; delete record.integrity; }
      if (artifact) { record.version = artifact.version; record.resolved = artifact.tarball; record.integrity = artifact.integrity; }
      for (const [dependency, spec] of Object.entries(record.requires ?? {})) record.requires[dependency] = rewriteVersionReference(dependency, spec, maps);
      legacy(record.dependencies);
    } };
    legacy(nextLock.dependencies);
    const root = nextLock.packages?.[""];
    if (isObject(root)) {
      root.version = nextManifest.version;
      rewriteDependencies(root, maps);
      rewriteOverrides(root.overrides, maps);
    }
  }
  return Object.freeze({ manifest: nextManifest, packageLock: nextLock, identity: identity === undefined ? null : { from: manifest.version, to: identity }, dependencyEdits: Object.freeze(dependencyEdits), invalidatedLockArtifacts: Object.freeze(invalidatedLockArtifacts.sort()) });
}
