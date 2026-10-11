export const DEFAULT_HOUSE_SCOPES = Object.freeze(["@red-cup-engineering", "@causeway-services", "@lenticule-science"]);

export function packageNameFromLockLocation(location) {
  const segments = location.split("/");
  const at = segments.lastIndexOf("node_modules");
  if (at === -1 || at === segments.length - 1) return null;
  const tail = segments.slice(at + 1);
  return tail[0]?.startsWith("@") ? tail.slice(0, 2).join("/") : tail[0] ?? null;
}

function normalizeRegistry(registry) {
  return registry.endsWith("/") ? registry : `${registry}/`;
}

/**
 * Classify every `resolved` URL an npm v2/v3 lockfile carries against one
 * canonical registry, so a fresh install can be judged by how many
 * dependencies it actually pulled from the house registry versus elsewhere.
 * A resolution whose owning package falls under a house scope but did not
 * resolve to the canonical registry is a distinct, higher-severity count
 * (`houseScopedNotCanonical`) from an ordinary public-npm resolution
 * (`notCanonicalRegistry`), which is expected for transitive public deps.
 * @param {object} packageLock A parsed npm v2/v3 package-lock.json document.
 * @param {string} canonicalRegistry The registry base URL every house-scoped resolution must carry.
 * @param {readonly string[]} [houseScopes] Package-name scopes this repository owns and publishes.
 * @returns {{resolvedTotal: number, canonical: number, notCanonicalRegistry: number, houseScopedNotCanonical: number, houseScopedNotCanonicalEntries: readonly {name: string|null, location: string, resolved: string}[]}}
 * @throws {TypeError} When packageLock is not an object or canonicalRegistry is not a nonempty string.
 */
export function classifyLockfileResolvedUrls(packageLock, canonicalRegistry, houseScopes = DEFAULT_HOUSE_SCOPES) {
  if (!packageLock || typeof packageLock !== "object") throw new TypeError("packageLock must be a parsed JSON object");
  if (typeof canonicalRegistry !== "string" || canonicalRegistry === "") throw new TypeError("canonicalRegistry must be a nonempty string");
  const base = normalizeRegistry(canonicalRegistry);
  const packages = packageLock.packages && typeof packageLock.packages === "object" ? packageLock.packages : {};
  let resolvedTotal = 0;
  let canonical = 0;
  const houseScopedNotCanonicalEntries = [];
  for (const [location, entry] of Object.entries(packages)) {
    if (location === "" || typeof entry?.resolved !== "string") continue;
    resolvedTotal += 1;
    if (entry.resolved.startsWith(base)) {
      canonical += 1;
      continue;
    }
    const name = entry.name ?? packageNameFromLockLocation(location);
    if (name !== null && houseScopes.some((scope) => name === scope || name.startsWith(`${scope}/`))) {
      houseScopedNotCanonicalEntries.push(Object.freeze({ name, location, resolved: entry.resolved }));
    }
  }
  return Object.freeze({
    resolvedTotal,
    canonical,
    notCanonicalRegistry: resolvedTotal - canonical,
    houseScopedNotCanonical: houseScopedNotCanonicalEntries.length,
    houseScopedNotCanonicalEntries: Object.freeze(houseScopedNotCanonicalEntries),
  });
}
