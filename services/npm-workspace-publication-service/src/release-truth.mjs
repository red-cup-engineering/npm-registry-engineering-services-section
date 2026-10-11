import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".tmp"]);

/**
 * Every package.json under root, including legacy ones — unlike
 * scanWorkspacePackages (workspace-graph.mjs), which deliberately skips
 * `legacy` directories. This scan needs them: a package that exists ONLY
 * under a legacy path is exactly the fact this module exists to catch.
 */
async function findAllManifests(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await findAllManifests(join(dir, entry.name), out);
    } else if (entry.name === "package.json") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** {name -> [{path, version, legacy}]} for every on-disk package.json under root. */
export async function scanAllManifestSites(root) {
  const paths = await findAllManifests(root, []);
  const byName = new Map();
  for (const path of paths) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest?.name !== "string" || manifest.name === "") continue;
    if (typeof manifest.version !== "string") continue;
    const site = Object.freeze({
      path,
      version: manifest.version,
      legacy: path.includes("/lib/legacy/") || path.includes("/legacy/"),
    });
    if (!byName.has(manifest.name)) byName.set(manifest.name, []);
    byName.get(manifest.name).push(site);
  }
  return byName;
}

/**
 * Classify one published (name, version) against its on-disk sites.
 *
 * - "no-disk-match": published, but no package.json anywhere carries this
 *   name — the source that produced it has since been renamed, deleted, or
 *   never lived in this checkout.
 * - "legacy-only": every on-disk site for this name lives under a legacy
 *   path. Nothing currently considers itself the live version of this
 *   package. Publishing it is a historical fact worth keeping (see the
 *   knowledge-join / append-only doctrine); tagging it `latest` is not —
 *   that's the exact shape of the 2026-08-12 FeltOS incident.
 * - "version-mismatch": a live (non-legacy) site exists for this name, but
 *   none of them carry the published version — the registry has drifted
 *   from the checkout.
 * - "live-match": a live site exists with the exact published version.
 *   This is the only category safe to treat as "real, current work."
 */
export function classifyPublishedPackage(pkg, sites) {
  const known = sites ?? [];
  if (known.length === 0) {
    return Object.freeze({ name: pkg.name, version: pkg.version, category: "no-disk-match", sites: [] });
  }
  const liveSites = known.filter((s) => !s.legacy);
  if (liveSites.length === 0) {
    return Object.freeze({ name: pkg.name, version: pkg.version, category: "legacy-only", sites: known });
  }
  const versionMatch = liveSites.some((s) => s.version === pkg.version);
  return Object.freeze({
    name: pkg.name,
    version: pkg.version,
    category: versionMatch ? "live-match" : "version-mismatch",
    sites: liveSites,
  });
}

/**
 * The one enforceable gate: which published packages are tagged with a
 * dist-tag (ordinarily "latest") that resolves to a legacy-only version.
 * Anyone consuming that tag by name gets retired content presented as
 * current, with no signal that anything is wrong — this is the mechanism,
 * not a one-off mistake, and it recurs for any package whose first-ever
 * publish happens to come from a legacy recovery.
 */
export function findMasqueradingTags(classifications, distTagsByName) {
  const flagged = [];
  for (const [name, tags] of distTagsByName) {
    for (const [tag, version] of Object.entries(tags)) {
      const hit = classifications.find((c) => c.name === name && c.version === version);
      if (hit?.category === "legacy-only") {
        flagged.push(Object.freeze({ name, tag, version, sites: hit.sites }));
      }
    }
  }
  return Object.freeze(flagged);
}
