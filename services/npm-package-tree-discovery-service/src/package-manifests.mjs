import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// These are generated or environmental copies rather than source packages.
// Deliberately do not exclude `legacy`: a decommissioned package normally
// lives there and remains a campaign candidate until its disposition closes.
export const DEFAULT_PACKAGE_MANIFEST_WALK_EXCLUDES = Object.freeze(["node_modules", ".git", "dist"]);

/**
 * Read every parseable package manifest below one root.
 *
 * A malformed or unreadable manifest is not a package candidate, but does not
 * prevent observing the rest of the tree.
 */
export async function listPackageManifests(root, { excludeDirectoryNames = DEFAULT_PACKAGE_MANIFEST_WALK_EXCLUDES } = {}) {
  if (typeof root !== "string" || root.length === 0) throw new TypeError("root is required");
  const base = resolve(root);
  const excludes = new Set(excludeDirectoryNames);
  const results = [];

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      const manifestPath = join(directory, "package.json");
      try {
        results.push(Object.freeze({ directory, manifestPath, manifest: JSON.parse(await readFile(manifestPath, "utf8")) }));
      } catch {
        // Discovery is total over readable manifests; invalid JSON is simply
        // not an admitted package carrier.
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !excludes.has(entry.name)) await walk(join(directory, entry.name));
    }
  }

  await walk(base);
  return Object.freeze(results.sort((a, b) => a.directory.localeCompare(b.directory)));
}
