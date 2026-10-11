#!/usr/bin/env node
// Recover pinned-but-unpublished package versions from git history.
//
// The workspace's manifests demand exact (name, version) pairs; the registry
// is the shelf that must hold every demanded artifact, including versions
// whose source has since moved on or been retired to legacy. This script
// indexes every package.json blob in the repository's history, locates each
// demanded pair, extracts that package directory at that commit, and
// publishes it. Historical versions are published under the `recovered`
// dist-tag so `latest` continues to name the current release.
//
// usage: recover-demanded-versions --missing <pairs.json> [--repo <dir>]
//        [--registry <url>] [--execute]
// pairs.json: [["@scope/name", "1.2.3"], ...]

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gitHistoryPlan, readBatchBlobs, readRawChange } from "@red-cup-engineering/git-services-section/git-command-codec";
import { isVersionPublished, repairStorageTarballURL } from "../src/registry.mjs";
import { secretBearingPaths } from "../src/tarball-guard.mjs";

// Sibling package under the same npm-registry-services-section; see
// publish-workspace-tiers.mjs for why this default exists.
const DEFAULT_STORAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "verdaccio-services-section", "data", "storage");

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const repo = opt("--repo", process.cwd());
const registry = opt("--registry", "http://127.0.0.1:4873/");
const registryStorage = opt("--registry-storage", DEFAULT_STORAGE_ROOT);
const missingPath = opt("--missing", null);
const execute = args.includes("--execute");
if (missingPath === null) {
  process.stderr.write("usage: recover-demanded-versions --missing <pairs.json> [--repo <dir>] [--registry <url>] [--registry-storage <dir>] [--execute]\n");
  process.exit(2);
}
const demanded = JSON.parse(await readFile(missingPath, "utf8"));

process.stderr.write("indexing package.json blobs across all history...\n");
const history = gitHistoryPlan.revisions({ pathspecs: ["**/package.json"] });
const log = await run(history.command, history.arguments, { cwd: repo, maxBuffer: 1024 * 1024 * 512 });
const blobSites = new Map(); // blob sha -> {commit, path} (first, i.e. newest, sighting)
let commit = null;
for (const line of log.stdout.split("\n")) {
  if (line.startsWith("@")) { commit = line.slice(1).split(" ")[0]; continue; }
  const change = readRawChange(line);
  if (change === undefined || change.status === "D" || !change.path.endsWith("package.json")) continue;
  if (!blobSites.has(change.after)) blobSites.set(change.after, { commit, path: change.path });
}
process.stderr.write(`unique manifest blobs: ${blobSites.size}\n`);

// Read every blob once and index (name, version) -> {commit, dir}.
const index = new Map();
const shas = [...blobSites.keys()];
const batch = gitHistoryPlan.blobs(shas);
const catFile = spawn(batch.command, batch.arguments, { cwd: repo });
const chunks = [];
catFile.stdout.on("data", (chunk) => chunks.push(chunk));
catFile.stdin.end(batch.input);
await new Promise((resolve, reject) => { catFile.on("close", resolve); catFile.on("error", reject); });
const bodies = readBatchBlobs(shas, Buffer.concat(chunks));
for (const [position, sha] of shas.entries()) {
  if (bodies[position] === undefined) continue;
  let manifest;
  try { manifest = JSON.parse(bodies[position]); } catch { continue; }
  if (typeof manifest?.name !== "string" || typeof manifest?.version !== "string") continue;
  const key = `${manifest.name}@${manifest.version}`;
  const site = blobSites.get(sha);
  if (!index.has(key)) index.set(key, { commit: site.commit, dir: dirname(site.path) });
}
process.stderr.write(`indexed distinct name@version manifests: ${index.size}\n`);

const results = [];
for (const [name, version] of demanded) {
  const key = `${name}@${version}`;
  const site = index.get(key);
  if (site === undefined) {
    results.push({ name, version, outcome: "unrecoverable", reason: "no commit in history carries this name@version manifest" });
    process.stderr.write(`${key}: unrecoverable\n`);
    continue;
  }
  if (!execute) {
    results.push({ name, version, outcome: "recoverable", commit: site.commit, dir: site.dir });
    continue;
  }
  const already = await isVersionPublished(registry, name, version);
  if (already.published) {
    results.push({ name, version, outcome: "already-published" });
    continue;
  }
  const work = await mkdtemp(join(tmpdir(), "recover-"));
  try {
    const archive = await run("git", ["archive", site.commit, "--", site.dir], { cwd: repo, encoding: "buffer", maxBuffer: 1024 * 1024 * 512 });
    await new Promise((resolve, reject) => {
      const tar = spawn("tar", ["-x", "--strip-components", String(site.dir.split("/").length), "-C", work]);
      tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
      tar.on("error", reject);
      tar.stdin.write(archive.stdout);
      tar.stdin.end();
    });
    await rm(join(work, "package-lock.json"), { force: true });
    // Historical manifests were often marked private before the registry
    // existed; the exact pins demanding this version are the evidence it was
    // consumed as an artifact. Stripping the flag is deliberate and recorded.
    const manifestPath = join(work, "package.json");
    const historical = JSON.parse(await readFile(manifestPath, "utf8"));
    const privateStripped = historical.private === true;
    if (privateStripped) {
      delete historical.private;
      await writeFile(manifestPath, JSON.stringify(historical, null, "\t") + "\n", "utf8");
    }
    // A recovered tarball must never carry credentials onto the shelf.
    const leaking = await secretBearingPaths(work);
    if (leaking.length > 0) {
      results.push({ name, version, outcome: "refused", reason: `secret-bearing tarball: ${leaking.join(", ")}`.slice(0, 400), commit: site.commit, dir: site.dir });
      process.stderr.write(`${key}: refused (secret-bearing)\n`);
      continue;
    }
    await run("npm", ["publish", "--ignore-scripts", "--provenance=false", "--tag", "recovered", "--registry", registry], { cwd: work });
    try {
      const repair = await repairStorageTarballURL(registryStorage, name, version);
      if (repair.changed) process.stderr.write(`${key}: repaired corrupted dist.tarball URL\n`);
    } catch (error) {
      process.stderr.write(`${key}: dist.tarball repair skipped: ${error?.message ?? error}\n`);
    }
    const check = await isVersionPublished(registry, name, version);
    results.push({ name, version, outcome: check.published ? "recovered-and-verified" : "published-but-unverified", commit: site.commit, dir: site.dir, privateStripped });
    process.stderr.write(`${key}: ${results.at(-1).outcome}\n`);
  } catch (error) {
    const reason = [error.stderr, error.stdout, error.message].map((part) => String(part ?? "").trim()).filter((part) => part !== "").join(" | ");
    results.push({ name, version, outcome: "refused", reason: reason.slice(-400), commit: site.commit, dir: site.dir });
    process.stderr.write(`${key}: refused\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
process.stdout.write(JSON.stringify({ registry, results }, null, 2) + "\n");
const bad = results.filter((entry) => entry.outcome === "refused" || entry.outcome === "unrecoverable");
process.exit(execute && bad.length > 0 ? 1 : 0);
