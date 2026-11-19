import { readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;

// Directories a package-discovery walk never has a reason to enter: dependency
// trees, version control, build output, and the registry's own prior output
// territories (walking into a built registry and reading its packed tarballs'
// nested package.json files back in as "source" would be circular).
const DEFAULT_IGNORED_DIRECTORY_NAMES = Object.freeze([
  "node_modules",
  ".git",
  "legacy",
  "_archive",
  "archive",
  ".tmp",
  "dist",
  ".pnpm-store",
]);

// Path segments this house already treats as non-source instance territory
// (see projectCarrier in package-registry.mjs, and pnpm-workspace.yaml's own
// exclusions) — a package.json living under one of these was never meant to
// be read as a live release candidate.
const DEFAULT_IGNORED_PATH_SEGMENTS = Object.freeze([
  "/content/assets/legacy/",
  "/content/retired-carriers/",
  "/content/runtime/",
  "/data/runtime-images/",
  // A Claude Code git-worktree checkout (created by the Agent tool's
  // isolation:"worktree" mode) is a full second copy of whatever subtree it
  // was cut from — every package.json under it is a name@version duplicate
  // of the real one, never a distinct release candidate.
  "/.claude/worktrees/",
]);

function normalize(path) {
  return path.split(sep).join("/");
}

function parseIgnoreFileText(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\/+$/u, ""))
    .filter((line) => !line.includes("/") && !line.includes("*"));
}

// Walks `root` for package.json files and sorts every one it reads into
// exactly one of two piles: `found` (a scoped, sovereign, exact-version
// manifest) or `skipped` (a directory or manifest this walk deliberately
// declined, with why).
// This never packs, never resolves versions, never talks to a registry —
// discovery answers "what is here", nothing more.
export async function discoverPackages({
  root,
  ignoreDirectoryNames = [],
  ignorePathSegments = [],
  reservedScopes = ["emsenn"],
} = {}) {
  if (typeof root !== "string" || root.length === 0) throw new TypeError("root is required");
  const base = resolve(root);
  const ignoredNames = new Set([...DEFAULT_IGNORED_DIRECTORY_NAMES, ...ignoreDirectoryNames]);
  const ignoredSegments = [...DEFAULT_IGNORED_PATH_SEGMENTS, ...ignorePathSegments];
  const reserved = new Set(reservedScopes);
  const found = [];
  const skipped = [];

  function framed(path) {
    const relative = normalize(path.slice(base.length));
    return relative.endsWith("/") ? relative : `${relative}/`;
  }

  async function inspect(directory) {
    const manifestPath = join(directory, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      skipped.push({ directory, reason: "unreadable-or-invalid-package-json", detail: error.message });
      return;
    }
    const name = manifest.name;
    if (typeof name !== "string" || !PACKAGE_NAME.test(name)) {
      skipped.push({ directory, name: name ?? null, reason: "name-not-scoped-sovereign" });
      return;
    }
    const scope = name.slice(1, name.indexOf("/"));
    if (reserved.has(scope)) {
      skipped.push({ directory, name, reason: "reserved-scope" });
      return;
    }
    const version = manifest.version;
    if (typeof version !== "string" || !VERSION.test(version)) {
      skipped.push({ directory, name, reason: "version-not-exact" });
      return;
    }
    found.push({ directory, name, version });
  }

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      skipped.push({ directory, reason: "unreadable-directory", detail: error.message });
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) await inspect(directory);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (ignoredNames.has(entry.name)) {
        skipped.push({ directory: path, reason: `ignored-directory-name:${entry.name}` });
        continue;
      }
      const relative = framed(path);
      if (relative.startsWith("/data/package-registry")) {
        skipped.push({ directory: path, reason: "registry-output-territory" });
        continue;
      }
      const segment = ignoredSegments.find((candidate) => relative.includes(candidate));
      if (segment !== undefined) {
        skipped.push({ directory: path, reason: `ignored-path-segment:${segment}` });
        continue;
      }
      await visit(path);
    }
  }

  await visit(base);
  found.sort((a, b) => a.name.localeCompare(b.name) || a.directory.localeCompare(b.directory));
  skipped.sort((a, b) => a.directory.localeCompare(b.directory));

  const collisionGroups = Object.groupBy(found, ({ name, version }) => `${name}@${version}`);
  const collisions = Object.entries(collisionGroups)
    .filter(([, rows]) => rows.length > 1)
    .map(([identity, rows]) => Object.freeze({ identity, directories: Object.freeze(rows.map((row) => row.directory)) }));

  return Object.freeze({
    type: "NpmPackageTreeDiscoveryReport",
    version: 2,
    root: base,
    found: Object.freeze(found.map((row) => Object.freeze(row))),
    skipped: Object.freeze(skipped.map((row) => Object.freeze(row))),
    collisions: Object.freeze(collisions),
  });
}

// A house .rgignore-style file: one bare directory-name pattern per line,
// `#` comments, trailing slashes trimmed. Segment/glob patterns (anything
// containing "/" or "*") are silently skipped — those need the walk's own
// `ignorePathSegments`, not a bare name, so a segment pattern here would
// otherwise be misread as a directory name and never match anything.
export async function loadIgnoreDirectoryNames(path) {
  return parseIgnoreFileText(await readFile(path, "utf8"));
}
