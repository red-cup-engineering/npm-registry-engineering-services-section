import {
  openNpmRegistry,
  readNpmPackument,
  readNpmRegistryReceipt,
  readNpmRegistryRelease,
} from "@red-cup-engineering/npm-registry-services-section/read-npm-registry-resource";
import { readPackageInterfaces } from "./package-interfaces.mjs";

export { packageBinaries, readPackageInterfaces } from "./package-interfaces.mjs";

const RECEIPT_TYPE = "SemioticVoxelPackageRegistryReceipt";

/**
 * Open the byte-preserving npm-registry read face used by query and graph
 * consumers. Receipt and packument records retain their exact source bytes;
 * release selects a requested version without a caller reimplementing npm's
 * `dist-tags.latest` rule.
 */
export function openNpmRegistryQuerySource({ registryRoot, registryUrl, fetchImplementation = fetch } = {}) {
  const registry = openNpmRegistry({ registryRoot, registryUrl, fetchImplementation });
  return Object.freeze({
    registry: registry.registry,
    receipt: () => readNpmRegistryReceipt(registry),
    packument: (name) => readNpmPackument(registry, name),
    release: (name, version) => readNpmRegistryRelease(registry, { name, version }),
  });
}

// Does this registry admit a packument for `name`? A clean boolean, never a
// crash — the absence of a package is an ordinary answer, not an exceptional
// one.
export async function packageExists(options) {
  const { name } = options;
  if (typeof name !== "string" || name.length === 0) throw new TypeError("name is required");
  const face = openNpmRegistryQuerySource(options);
  const packument = await face.packument(name);
  return Object.freeze({ type: "NpmPackageExistenceAnswer", registry: face.registry, name, exists: packument !== null });
}

// Every distinct package name this registry's receipt admits, filtered by a
// case-insensitive substring or an explicit RegExp — a search, not a filter
// that throws when its input doesn't match: an empty result is a legitimate
// answer.
export async function searchPackages(options) {
  const { pattern } = options;
  if (typeof pattern !== "string" && !(pattern instanceof RegExp)) throw new TypeError("pattern must be a string or RegExp");
  const face = openNpmRegistryQuerySource(options);
  const receipt = await face.receipt();
  if (receipt?.value?.type !== RECEIPT_TYPE || !Array.isArray(receipt.value.packages)) throw new Error("registry has no recognized build receipt");
  const names = [...new Set(receipt.value.packages.map((entry) => entry.name))].sort();
  const matcher = pattern instanceof RegExp ? pattern : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
  const matches = names.filter((name) => {
    matcher.lastIndex = 0;
    return matcher.test(name);
  });
  return Object.freeze({ type: "NpmPackageSearchAnswer", registry: face.registry, pattern: String(pattern), matches: Object.freeze(matches) });
}

function dependencyMap(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
  };
}

async function resolvedVersion(face, name, version) {
  const resolved = await face.release(name, version);
  return { packument: resolved.document?.value ?? null, version: resolved.version, manifest: resolved.manifest };
}

// Which standard npm interfaces does this exact release publish? This reads
// manifest data only: it does not infer exported function names, contracts,
// effects, or semantic composition from an entrypoint path.
export async function interfacesOf(options) {
  const { name, version } = options;
  if (typeof name !== "string" || name.length === 0) throw new TypeError("name is required");
  if (version !== undefined && (typeof version !== "string" || version.length === 0)) throw new TypeError("version must be a non-empty string when supplied");
  const face = openNpmRegistryQuerySource(options);
  const resolved = await resolvedVersion(face, name, version);
  if (resolved.manifest === null) {
    return Object.freeze({ type: "NpmPackageInterfacesAnswer", registry: face.registry, name, version: version ?? null, found: false, interfaces: null });
  }
  return Object.freeze({
    type: "NpmPackageInterfacesAnswer",
    registry: face.registry,
    name,
    version: resolved.version,
    found: true,
    interfaces: readPackageInterfaces(resolved.manifest),
  });
}

// What does name@version (default: dist-tags.latest) declare as a dependency?
// A clean "package not found" or "version not found" answer, never a crash.
export async function dependenciesOf(options) {
  const { name, version } = options;
  if (typeof name !== "string" || name.length === 0) throw new TypeError("name is required");
  if (version !== undefined && (typeof version !== "string" || version.length === 0)) throw new TypeError("version must be a non-empty string when supplied");
  const face = openNpmRegistryQuerySource(options);
  const resolved = await resolvedVersion(face, name, version);
  if (resolved.manifest === null) {
    return Object.freeze({ type: "NpmPackageDependenciesAnswer", registry: face.registry, name, version: version ?? null, found: false, dependencies: Object.freeze([]) });
  }
  const dependencies = Object.entries(dependencyMap(resolved.manifest)).sort(([a], [b]) => a.localeCompare(b))
    .map(([dependency, constraint]) => Object.freeze({ name: dependency, constraint }));
  return Object.freeze({ type: "NpmPackageDependenciesAnswer", registry: face.registry, name, version: resolved.version, found: true, dependencies: Object.freeze(dependencies) });
}

// Who, among this registry's own receipt entries, directly depends on `name`?
// This only ever answers over a registry that has a receipt (the "ours" set
// registry-graph.mjs itself uses for the no-argument case) — a live third-party
// registry has no bounded universe to scan.
export async function dependentsOf(options) {
  const { name } = options;
  if (typeof name !== "string" || name.length === 0) throw new TypeError("name is required");
  const face = openNpmRegistryQuerySource(options);
  const receipt = await face.receipt();
  if (receipt?.value?.type !== RECEIPT_TYPE || !Array.isArray(receipt.value.packages)) throw new Error("registry has no recognized build receipt; dependents can only be found within a registry this house built");
  const dependents = [];
  const seen = new Set();
  for (const entry of receipt.value.packages) {
    const identity = `${entry.name}@${entry.version}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const packument = await face.packument(entry.name);
    const manifest = packument?.value?.versions?.[entry.version];
    if (!manifest) continue;
    const constraint = dependencyMap(manifest)[name];
    if (constraint !== undefined) dependents.push(Object.freeze({ name: entry.name, version: entry.version, constraint }));
  }
  dependents.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return Object.freeze({ type: "NpmPackageDependentsAnswer", registry: face.registry, name, dependents: Object.freeze(dependents) });
}
