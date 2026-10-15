import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { packagesFromManifests } from "./workspace-graph.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".tmp"]);
const ARCHIVE_DIRS = new Set(["legacy", "archive", "_archive", "triage"]);

async function findManifests(dir, out, includeArchived = false) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || (!includeArchived && ARCHIVE_DIRS.has(entry.name))) continue;
      if (!includeArchived && basename(dir) === "data" && ["captures", "storage"].includes(entry.name)) continue;
      if (!includeArchived && ["test", "tests"].includes(basename(dir)) && entry.name === "fixtures") continue;
      await findManifests(join(dir, entry.name), out, includeArchived);
    } else if (entry.name === "package.json") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

async function readManifests(paths) {
  const manifests = [];
  for (const path of paths) {
    try {
      manifests.push(Object.freeze({
        path,
        dir: path.slice(0, -"/package.json".length),
        manifest: JSON.parse(await readFile(path, "utf8")),
      }));
    } catch {
      manifests.push(Object.freeze({ path, dir: path.slice(0, -"/package.json".length), manifest: null }));
    }
  }
  return Object.freeze(manifests);
}

export async function scanWorkspaceManifests(root) {
  return readManifests([join(resolve(root), "package.json")]);
}

export async function scanRepositoryManifests(root) {
  const paths = await findManifests(root, [], true);
  return readManifests(paths);
}

/**
 * Scan a workspace root for publishable packages: named, versioned, private
 * flag absent. The dependency map spans every field used by clean
 * verification. The disk read lives here; packagesFromManifests
 * (workspace-graph.mjs) does the pure selection over the manifests read.
 */
export async function scanWorkspacePackages(root) {
  const manifests = await scanWorkspaceManifests(root);
  return packagesFromManifests(manifests);
}
