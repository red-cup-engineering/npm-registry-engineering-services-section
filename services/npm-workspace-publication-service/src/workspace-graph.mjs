import { createGraph, topologicalTiers } from "@red-cup-engineering/metrologic/models/graphs/directed-multigraph";

const DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

/** A coordinated release edge names the provider's declared exact identity. */
const namesSite = (specification, site) => site?.version === specification;

export function dependencyEntries(manifest) {
  const entries = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, specification] of Object.entries(manifest[field] ?? {})) {
      const prior = entries.get(name);
      if (prior !== undefined && prior !== specification) throw new Error(`${manifest.name} declares conflicting versions for ${name}`);
      entries.set(name, specification);
    }
  }
  return entries;
}

/**
 * Select publishable packages from an already-read set of manifests: named,
 * versioned, private flag absent. The dependency map spans every field used
 * by clean verification. `manifests` is the shape scanWorkspaceManifests (in
 * read-workspace-manifests.mjs) reads from disk: `{ path, dir, manifest }`.
 */
export function packagesFromManifests(manifests) {
  const packages = [];
  for (const { path, manifest } of manifests) {
    if (manifest === null) continue;
    if (typeof manifest?.name !== "string" || manifest.name === "") continue;
    if (typeof manifest.version !== "string" || manifest.private === true) continue;
    packages.push(Object.freeze({
      name: manifest.name,
      version: manifest.version,
      dir: path.slice(0, -"/package.json".length),
      manifest: Object.freeze(structuredClone(manifest)),
      dependencies: Object.freeze(Object.fromEntries(dependencyEntries(manifest))),
    }));
  }
  return Object.freeze(packages);
}

/**
 * An internal edge is any lifecycle-relevant dependency whose name is itself a
 * workspace package—no scope list needed; membership defines "house."
 */
export function internalDependencyGraph(packages) {
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const edges = new Map();
  for (const entry of packages) {
    edges.set(entry.name, Object.freeze(
      Object.entries(entry.dependencies)
        .filter(([dep, specification]) => byName.has(dep) && namesSite(specification, byName.get(dep)) && dep !== entry.name)
        .map(([dep]) => dep),
    ));
  }
  return Object.freeze({ byName, edges });
}

/**
 * Select named workspace packages and every workspace package they depend on.
 * Package names are identities here: an absent or duplicated identity makes
 * the requested publication set ambiguous and is therefore refused.
 */
export function workspaceDependencyClosure(packages, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return packages;
  const sitesByName = new Map();
  for (const entry of packages) {
    if (!sitesByName.has(entry.name)) sitesByName.set(entry.name, []);
    sitesByName.get(entry.name).push(entry);
  }
  const selected = new Set();
  const pending = [];
  for (const name of new Set(roots)) {
    const sites = sitesByName.get(name) ?? [];
    if (sites.length === 0) throw new Error(`workspace package is absent: ${name}`);
    if (sites.length > 1) throw new Error(`workspace package identity is duplicated: ${name}`);
    pending.push(sites[0]);
  }
  while (pending.length > 0) {
    const site = pending.shift();
    if (selected.has(site)) continue;
    selected.add(site);
    for (const [dependency, specification] of Object.entries(site.dependencies)) {
      const providers = (sitesByName.get(dependency) ?? []).filter((candidate) => namesSite(specification, candidate));
      if (providers.length > 1) throw new Error(`workspace package identity is duplicated: ${dependency}@${specification}`);
      if (providers.length === 1) pending.push(providers[0]);
    }
  }
  return Object.freeze(packages.filter((entry) => selected.has(entry)));
}

/**
 * Kahn tiering: tier 0 is packages with no internal dependencies (leaves);
 * each next tier depends only on earlier tiers. Cycles are reported, not
 * thrown: members of a dependency cycle appear in `cyclic`, never in a tier.
 * Delegates to SignGraph's shared Kahn-by-levels; edges are added
 * reversed (dependency -> dependent) since topologicalTiers places
 * zero-*incoming* nodes first, and a tier-0 package here is one with zero
 * *dependencies*.
 */
export function leafFirstTiers(packages) {
  const { edges } = internalDependencyGraph(packages);
  const graph = createGraph({ nodes: [...edges.keys()].map((id) => ({ id })) });
  for (const [name, deps] of edges) for (const dep of deps) graph.addEdge({ from: dep, to: name });
  const { tiers: rawTiers, cycle } = topologicalTiers(graph);
  return Object.freeze({
    tiers: Object.freeze(rawTiers.map((tier) => Object.freeze([...tier].sort()))),
    cyclic: Object.freeze(cycle === undefined ? [] : [...cycle].sort()),
  });
}
