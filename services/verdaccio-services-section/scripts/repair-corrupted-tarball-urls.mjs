#!/usr/bin/env node
// Repairs the tarball-URL corruption described in
// content/config/corrupted-tarball-urls.md: the npm client observed
// publishing to this registry (npm 11.17.0 against Verdaccio 6.9.2)
// self-reports a dist.tarball URL that duplicates the full scoped package
// name a second time after the `/-/` separator, e.g.
//   .../@scope/name/-/@scope/name-1.0.0.tgz
// instead of the route Verdaccio actually serves (and the attachment is
// actually stored under):
//   .../@scope/name/-/name-1.0.0.tgz
//
// This walks every package.json under this service's storage/ directory,
// scope and unscoped alike, and rewrites any dist.tarball entry carrying that
// exact shape back to the correct one. Verdaccio faithfully stored whatever
// the client sent, so this is a metadata repair only: no .tgz content is
// ever read, moved, or rewritten. Idempotent — running it again finds
// nothing left to change. Skips a fixed list of package identities the
// caller may be publishing concurrently (see EXCLUDED_NAMES below); rerun
// once those publications have settled to pick up any strays.
//
// usage: repair-corrupted-tarball-urls [--storage <dir>] [--dry-run]
//        [--exclude <name>]...


import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argument, repeatedArgument } from "@red-cup-engineering/javascript-node-services-section/argv";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";

// Same corruption test as
// npm-workspace-publication-service/src/tarball-guard.mjs's
// correctedTarballURL — duplicated here deliberately rather than imported:
// estate doctrine publishes registry coordinates between sibling packages
// and does not workspace-link source across them.
function correctedTarballURL(tarballURL, name) {
  if (typeof tarballURL !== "string" || tarballURL === "" || typeof name !== "string" || name === "") return null;
  const marker = `/-/${name}-`;
  const at = tarballURL.indexOf(marker);
  if (at === -1) return null;
  const leaf = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  const corrected = `${tarballURL.slice(0, at)}/-/${leaf}-${tarballURL.slice(at + marker.length)}`;
  // Unscoped names have leaf === name, so an already-correct unscoped URL
  // matches `marker` too; only report a change when one is truly needed.
  return corrected === tarballURL ? null : corrected;
}

const DEFAULT_STORAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "storage");

// The nine agent-computing verb packages a concurrent publish workflow is
// actively writing at the time this script was written. Never touch these;
// rerun later once that workflow has settled.
const EXCLUDED_NAMES = new Set([
  "relating", "animating", "communicating", "knowing", "playing",
  "computing", "gaming", "socializing", "organizing",
].map((verb) => `@red-cup-engineering/${verb}`));

const args = process.argv.slice(2);
const opt = (name, fallback) => argument(name, args) ?? fallback;
if (args.includes("--help")) {
  process.stderr.write(
    "usage: repair-corrupted-tarball-urls [--storage <dir>] [--dry-run] [--exclude <name>]...\n" +
    "Walks every package.json under storage/ and rewrites any dist.tarball that\n" +
    "duplicates the package name after /-/ back to Verdaccio's real route.\n" +
    "Metadata-only; never reads or moves .tgz bytes. Idempotent.\n",
  );
  process.exit(0);
}
const storageRoot = resolve(opt("--storage", DEFAULT_STORAGE_ROOT));
const dryRun = args.includes("--dry-run");
const excluded = new Set(EXCLUDED_NAMES);
for (const name of repeatedArgument("--exclude", args)) excluded.add(name);

async function packageNamesUnder(root) {
  const names = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of await readdir(join(root, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) names.push(`${entry.name}/${scoped.name}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function repairPackage(name) {
  const path = join(storageRoot, ...name.split("/"), "package.json");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { name, outcome: "no-metadata" };
    throw error;
  }
  let packument;
  try {
    packument = JSON.parse(raw);
  } catch {
    return { name, outcome: "unparsable-metadata" };
  }
  if (!packument || typeof packument !== "object" || packument.name !== name || !packument.versions || typeof packument.versions !== "object") {
    return { name, outcome: "not-a-packument" };
  }
  const fixedVersions = [];
  for (const [version, manifest] of Object.entries(packument.versions)) {
    if (!manifest || typeof manifest !== "object") continue;
    const corrected = correctedTarballURL(manifest.dist?.tarball, name);
    if (corrected === null) continue;
    manifest.dist.tarball = corrected;
    fixedVersions.push(version);
  }
  if (fixedVersions.length === 0) return { name, outcome: "clean", fixedVersions };
  if (!dryRun) {
    await writeFileText(path, `${JSON.stringify(packument, null, 2)}\n`);
  }
  return { name, outcome: dryRun ? "would-repair" : "repaired", fixedVersions };
}

const names = await packageNamesUnder(storageRoot);
const results = [];
for (const name of names) {
  if (excluded.has(name)) {
    results.push({ name, outcome: "skipped-excluded" });
    continue;
  }
  results.push(await repairPackage(name));
}

const repaired = results.filter((r) => r.outcome === "repaired" || r.outcome === "would-repair");
const versionsFixed = repaired.reduce((sum, r) => sum + r.fixedVersions.length, 0);
const skipped = results.filter((r) => r.outcome === "skipped-excluded");
const problems = results.filter((r) => r.outcome === "unparsable-metadata" || r.outcome === "not-a-packument");

for (const r of repaired) process.stderr.write(`${r.name}: ${r.outcome} (${r.fixedVersions.length} version(s): ${r.fixedVersions.join(", ")})\n`);
for (const r of problems) process.stderr.write(`${r.name}: ${r.outcome}\n`);

process.stdout.write(`${JSON.stringify({
  storageRoot,
  dryRun,
  packagesScanned: results.length,
  packagesRepaired: repaired.length,
  versionsFixed,
  packagesSkippedExcluded: skipped.length,
  packagesWithProblems: problems.length,
  excludedNames: [...excluded].sort(),
}, null, 2)}\n`);
