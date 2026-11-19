import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_PACKAGE_MANIFEST_WALK_EXCLUDES, listPackageManifests } from "./package-manifests.mjs";

const execFileAsync = promisify(execFile);

// Directory names never worth walking into or hashing: dependency trees,
// version control, and build output. Unlike discover-npm-packages.mjs's
// walk, this one does NOT exclude "legacy"/"archive" — those are exactly
// the territory Lot S measures.
const DEFAULT_WALK_EXCLUDES = DEFAULT_PACKAGE_MANIFEST_WALK_EXCLUDES;
const DIGEST_EXCLUDED_FILE_NAMES = Object.freeze(["package-lock.json"]);
const DIGEST_EXCLUDED_FILE_PATTERNS = Object.freeze([/\.log$/u]);

function normalize(path) {
  return path.split(sep).join("/");
}

/**
 * Walks `root` for every readable, parseable package.json, skipping
 * `node_modules`, `.git`, and `dist` at any depth.
 * @param {string} root - Absolute or relative directory to walk.
 * @param {{excludeDirectoryNames?: Set<string>}} [options]
 * @returns {Promise<Array<{directory: string, manifestPath: string, manifest: object}>>}
 *   Rows sorted by directory. A directory with unreadable or invalid JSON
 *   contributes no row.
 */
/**
 * Computes a deterministic content digest for one directory: sha-256 over
 * its sorted relative-path list followed by each file's bytes in that same
 * order, excluding `node_modules`, `.git`, `dist`, `package-lock.json`, and
 * `*.log` files.
 * @param {string} directory
 * @returns {Promise<{digest: string, bytes: number, files: number}>}
 */
export async function computeDirectoryContentDigest(directory) {
  const base = resolve(directory);
  const excludeDirectoryNames = new Set(DEFAULT_WALK_EXCLUDES);
  const files = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeDirectoryNames.has(entry.name)) continue;
        await walk(join(current, entry.name));
      } else if (entry.isFile()) {
        if (DIGEST_EXCLUDED_FILE_NAMES.includes(entry.name)) continue;
        if (DIGEST_EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
        files.push(join(current, entry.name));
      }
    }
  }

  await walk(base);
  const relatives = files.map((file) => normalize(resolve(file).slice(base.length + 1))).sort();
  const hash = createHash("sha256");
  hash.update(relatives.join("\n"));
  let bytes = 0;
  for (const relativePath of relatives) {
    const contents = await readFile(join(base, relativePath));
    hash.update(contents);
    bytes += contents.byteLength;
  }
  return { digest: hash.digest("hex"), bytes, files: relatives.length };
}

/**
 * Groups every named package.json under `root` by manifest `name`, and for
 * each name replicated across 2+ directories, computes a content digest per
 * directory and partitions the byte-identical copies.
 * @param {{root: string, excludeDirectoryNames?: string[]}} options
 * @returns {Promise<object>} Frozen `npm.replicated-package-copies` report:
 *   `{kind, groups: [{name, copies: [{dir, digest, bytes, files, legacy, live}],
 *   identicalSets: [[dir, ...]]}], totals: {groups, copies, identicalExtras,
 *   identicalExtraBytes}}`.
 */
export async function deriveReplicatedPackageCopies({ root, excludeDirectoryNames = DEFAULT_WALK_EXCLUDES } = {}) {
  if (typeof root !== "string" || root.length === 0) throw new TypeError("root is required");
  const manifests = await listPackageManifests(root, { excludeDirectoryNames: new Set(excludeDirectoryNames) });
  const named = manifests.filter((row) => typeof row.manifest.name === "string" && row.manifest.name.length > 0);
  const byName = Object.groupBy(named, (row) => row.manifest.name);

  const groups = [];
  let totalCopies = 0;
  let identicalExtras = 0;
  let identicalExtraBytes = 0;

  for (const [name, rows] of Object.entries(byName).sort(([a], [b]) => a.localeCompare(b))) {
    if (rows.length < 2) continue;
    const copies = [];
    for (const row of rows) {
      const { digest, bytes, files } = await computeDirectoryContentDigest(row.directory);
      const legacy = normalize(row.directory).includes("/lib/legacy/");
      copies.push({ dir: row.directory, digest, bytes, files, legacy, live: !legacy });
    }
    copies.sort((a, b) => a.dir.localeCompare(b.dir));

    const byDigest = Object.groupBy(copies, (copy) => copy.digest);
    const identicalSets = Object.values(byDigest)
      .filter((set) => set.length > 1)
      .map((set) => set.map((copy) => copy.dir).sort())
      .sort((a, b) => a[0].localeCompare(b[0]));

    for (const set of identicalSets) {
      const extras = set.length - 1;
      identicalExtras += extras;
      identicalExtraBytes += extras * copies.find((copy) => copy.dir === set[0]).bytes;
    }

    totalCopies += copies.length;
    groups.push({ name, copies, identicalSets });
  }

  groups.sort((a, b) => a.name.localeCompare(b.name));

  return Object.freeze({
    kind: "npm.replicated-package-copies",
    groups: Object.freeze(
      groups.map((group) =>
        Object.freeze({
          name: group.name,
          copies: Object.freeze(group.copies.map((copy) => Object.freeze(copy))),
          identicalSets: Object.freeze(group.identicalSets.map((set) => Object.freeze(set))),
        }),
      ),
    ),
    totals: Object.freeze({ groups: groups.length, copies: totalCopies, identicalExtras, identicalExtraBytes }),
  });
}

/**
 * Finds every package.json under `root` whose `file:` dependency resolves
 * to `directory`.
 * @param {string} root
 * @param {string} directory
 * @returns {Promise<Array<{manifestPath: string, depName: string, depValue: string}>>}
 */
export async function findFileDependencyReferences(root, directory) {
  const manifests = await listPackageManifests(root);
  const target = resolve(directory);
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const refs = [];
  for (const { manifestPath, manifest } of manifests) {
    for (const field of fields) {
      const deps = manifest[field];
      if (deps === null || typeof deps !== "object") continue;
      for (const [depName, depValue] of Object.entries(deps)) {
        if (typeof depValue !== "string" || !depValue.startsWith("file:")) continue;
        const resolved = resolve(dirname(manifestPath), depValue.slice("file:".length));
        if (resolved === target) refs.push({ manifestPath, depName, depValue });
      }
    }
  }
  return refs;
}

/**
 * Finds every systemd user unit whose contents mention `directory`.
 * @param {string} directory
 * @param {{systemdUserDir?: string}} [options]
 * @returns {Promise<Array<{unitPath: string}>>}
 */
export async function findSystemdUnitReferences(directory, { systemdUserDir = join(homedir(), ".config", "systemd", "user") } = {}) {
  let entries;
  try {
    entries = await readdir(systemdUserDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const target = resolve(directory);
  const refs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".service")) continue;
    const unitPath = join(systemdUserDir, entry.name);
    const text = await readFile(unitPath, "utf8").catch(() => "");
    if (text.includes(target)) refs.push({ unitPath });
  }
  return refs;
}

/**
 * Finds non-legacy source files under `root` that mention `directory`'s
 * path relative to `root`, as evidence it is still consumed rather than
 * being dead archive weight.
 * @param {string} root
 * @param {string} directory
 * @returns {Promise<string[]>} Absolute paths of matching non-legacy files.
 */
export async function findNonLegacySourceReferences(root, directory) {
  const base = resolve(root);
  const target = resolve(directory);
  const relative = normalize(target.slice(base.length + 1));
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "rg",
      ["--fixed-strings", "--files-with-matches", "--glob", "!node_modules", "--glob", "!.git", "--glob", "!dist", "--", relative, base],
      { maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch (error) {
    if (error.code === 1) return []; // rg's "no matches" exit code
    throw error;
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => resolve(file))
    .filter((file) => file !== target && !file.startsWith(`${target}${sep}`))
    .filter((file) => !normalize(file).includes("/lib/legacy/"));
}

/**
 * Describes every reference that would refuse deleting `directory`.
 * @param {{root: string, directory: string}} options
 * @returns {Promise<string[]>} Human-readable reference descriptors; empty
 *   when nothing references the directory.
 */
export async function describePackageDirectoryReferences({ root, directory }) {
  const refs = [];
  for (const ref of await findFileDependencyReferences(root, directory)) {
    refs.push(`file-dependency:${ref.manifestPath}#${ref.depName}`);
  }
  for (const ref of await findSystemdUnitReferences(directory)) {
    refs.push(`systemd-unit:${ref.unitPath}`);
  }
  for (const file of await findNonLegacySourceReferences(root, directory)) {
    refs.push(`source-file:${file}`);
  }
  return refs;
}

/**
 * Plans (and, with `apply`, performs) deletion of the 2nd..nth byte-identical
 * copy in every replicated-package identical set: keeps a live (non-legacy)
 * copy when the set has one, else the lexically-first legacy path. A set
 * with any delete candidate still referenced (a `file:` dependency, a
 * systemd user unit, or a non-legacy source file) is skipped whole — no
 * copy in it is deleted.
 * @param {{root: string, apply?: boolean}} options
 * @returns {Promise<object>} Frozen `{deleted: [{dir, bytes}], kept: [dir],
 *   skipped: [{set, reason}]}`.
 */
export async function purgeIdenticalPackageReplicas({ root, apply = false } = {}) {
  const report = await deriveReplicatedPackageCopies({ root });
  const deleted = [];
  const kept = [];
  const skipped = [];

  for (const group of report.groups) {
    for (const set of group.identicalSets) {
      const byDir = new Map(group.copies.map((copy) => [copy.dir, copy]));
      const members = set.map((dir) => byDir.get(dir));
      const liveMember = members.find((member) => member.live);
      const keepMember = liveMember ?? [...members].sort((a, b) => a.dir.localeCompare(b.dir))[0];
      const candidates = members.filter((member) => member.dir !== keepMember.dir);

      const referenceLines = [];
      for (const candidate of candidates) {
        const refs = await describePackageDirectoryReferences({ root, directory: candidate.dir });
        if (refs.length > 0) referenceLines.push(`${candidate.dir}: ${refs.join("; ")}`);
      }

      if (referenceLines.length > 0) {
        skipped.push({ set, reason: referenceLines.join(" | ") });
        continue;
      }

      kept.push(keepMember.dir);
      for (const candidate of candidates) {
        if (apply) await rm(candidate.dir, { recursive: true, force: true });
        deleted.push({ dir: candidate.dir, bytes: candidate.bytes });
      }
    }
  }

  deleted.sort((a, b) => a.dir.localeCompare(b.dir));
  kept.sort((a, b) => a.localeCompare(b));
  skipped.sort((a, b) => a.set[0].localeCompare(b.set[0]));

  return Object.freeze({
    deleted: Object.freeze(deleted.map((row) => Object.freeze(row))),
    kept: Object.freeze(kept),
    skipped: Object.freeze(skipped.map((row) => Object.freeze({ set: Object.freeze(row.set), reason: row.reason }))),
  });
}
