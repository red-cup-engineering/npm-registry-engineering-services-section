#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isVersionPublished, readRegistryStorageVersions } from "../src/registry.mjs";
import { planReleaseWave } from "../src/release-wave.mjs";
import { scanWorkspaceManifests } from "../src/read-workspace-manifests.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const root = resolve(option("--root", process.cwd()));
const registry = option("--registry", "http://127.0.0.1:4873/");
const registryConcurrency = Number.parseInt(option("--registry-concurrency", "2"), 10);
const registryStorage = option("--registry-storage", null);
const reportPath = option("--report", null);
const apply = args.includes("--apply");
const releaseKind = option("--release-kind", "stable");
const channel = option("--channel", undefined);
const bump = option("--bump", "patch");
const promotionAdmissionsPath = option("--promotion-admissions", undefined);

if (!["stable", "prerelease"].includes(releaseKind)) throw new Error("--release-kind must be stable or prerelease");
if (releaseKind === "stable" && channel !== undefined) throw new Error("--channel is only valid for a prerelease wave");
if (!["major", "minor", "patch"].includes(bump)) throw new Error("--bump must be major, minor, or patch");

if (!Number.isSafeInteger(registryConcurrency) || registryConcurrency < 1) {
  throw new Error("--registry-concurrency must be a positive integer");
}

if (args.includes("--help")) {
  process.stderr.write(
    "usage: prepare-release-wave [--root <dir>] [--registry <url>] [--registry-storage <dir>] [--registry-concurrency <n>] [--release-kind stable|prerelease] [--channel <tag>] [--bump major|minor|patch] [--promotion-admissions <file>] [--report <file>] [--apply]\n" +
    "Plans from every tracked or untracked changed file in an active package. Changed\n" +
    "published identities receive an unused version; prerelease waves allocate\n" +
    "X.Y.Z-tag.0 then increment N; an explicitly selected prerelease wave defaults to\n" +
    "the dev channel. Exact internal consumers are retargeted to a fixed\n" +
    "point. --apply rewrites manifests and lock roots.\n",
  );
  process.exit(0);
}

const sites = (await scanWorkspaceManifests(root)).filter(({ manifest }) =>
  typeof manifest?.name === "string" && manifest.name !== "" && typeof manifest.version === "string");
const packages = sites.map((site) => ({
  ...site,
  name: site.manifest.name,
  version: site.manifest.version,
  private: site.manifest.private === true,
}));
const byName = new Map();
for (const entry of packages) {
  if (byName.has(entry.name)) throw new Error(`active package identity is duplicated: ${entry.name}`);
  byName.set(entry.name, entry);
}

const [{ stdout: repositoryRootOutput }, { stdout: tracked }, { stdout: untracked }] = await Promise.all([
  run("git", ["rev-parse", "--show-toplevel"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }),
  run("git", ["diff", "HEAD", "--name-only", "--no-renames"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }),
  run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }),
]);
const repositoryRoot = resolve(repositoryRootOutput.trim());
const changedFiles = [...new Set(`${tracked}\n${untracked}`.trim().split(/\n/).filter(Boolean))];
const ownerDirs = [...packages].sort((left, right) => right.dir.length - left.dir.length);
const changedNames = new Set();
for (const file of changedFiles) {
  // Git paths are relative to the repository top-level, even when a caller
  // selects a nested subtree as the release root.  Comparing those paths to
  // the selected subtree made every nested consumer invisible to the wave.
  const absolute = resolve(repositoryRoot, file);
  const owner = ownerDirs.find(({ dir }) => absolute === resolve(dir, "package.json") || absolute.startsWith(`${dir}${sep}`));
  if (owner) changedNames.add(owner.name);
}

const occupiedByName = new Map();
const promotionAdmissions = new Map();
if (promotionAdmissionsPath !== undefined) {
  const document = JSON.parse(await readFile(resolve(promotionAdmissionsPath), "utf8"));
  if (document?.profile !== "org.emsenn.npm-promotion-admissions.v1" || !Array.isArray(document.admissions)) throw new Error("--promotion-admissions must carry org.emsenn.npm-promotion-admissions.v1");
  for (const admission of document.admissions) {
    if (typeof admission?.name !== "string" || promotionAdmissions.has(admission.name)) throw new Error("promotion admissions require unique package names");
    promotionAdmissions.set(admission.name, Object.freeze({ ...admission }));
  }
}
async function probeIdentities(identities) {
  const pending = [...identities];
  const results = [];
  await Promise.all(Array.from({ length: Math.min(registryConcurrency, pending.length) }, async () => {
    while (pending.length > 0) {
      const identity = pending.pop();
      const result = await isVersionPublished(registry, identity.name, identity.version);
      if (!result.reachable) throw new Error(`registry is unreachable while reading ${identity.name}@${identity.version}: ${registry}`);
      results.push({ ...identity, published: result.published });
    }
  }));
  return results;
}

const currentIdentities = packages
  .filter(({ private: isPrivate }) => !isPrivate)
  .map(({ name, version }) => ({ name, version }));
if (registryStorage) {
  const stored = await readRegistryStorageVersions(registryStorage, currentIdentities.map(({ name }) => name));
  for (const [name, versions] of stored) occupiedByName.set(name, versions);
} else {
  for (const { name, version, published } of await probeIdentities(currentIdentities)) {
    occupiedByName.set(name, new Set(published ? [version] : []));
  }
}

const releaseOptions = { releaseKind, ...(channel === undefined ? {} : { channel }), bump, promotionAdmissions };
let plan = planReleaseWave(packages, changedNames, occupiedByName, releaseOptions);
while (true) {
  const candidates = plan.targets
    .filter(({ name, from, to }) => from !== to && !(occupiedByName.get(name)?.has(to)))
    .map(({ name, to }) => ({ name, version: to }));
  const collisions = registryStorage
    ? candidates.filter(({ name, version }) => occupiedByName.get(name)?.has(version)).map((identity) => ({ ...identity, published: true }))
    : (await probeIdentities(candidates)).filter(({ published }) => published);
  if (collisions.length === 0) break;
  for (const { name, version } of collisions) occupiedByName.get(name).add(version);
  plan = planReleaseWave(packages, changedNames, occupiedByName, releaseOptions);
}
const receipt = {
  root,
  registry,
  releaseKind,
  channel: plan.channel,
  bump,
  changedFiles: changedFiles.length,
  directlyChangedPackages: changedNames.size,
  releasePackages: plan.targets.length,
  bumpedPackages: plan.targets.filter(({ bumped }) => bumped).length,
  retainedUnpublishedVersions: plan.targets.filter(({ bumped }) => !bumped).length,
  dependencyEdits: plan.dependencyEdits.length,
  plan,
};

if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(receipt, null, 2)}\n`);
if (!apply) {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(0);
}

const manifests = new Map(packages.map((entry) => [entry.name, structuredClone(entry.manifest)]));
for (const { name, to } of plan.targets) manifests.get(name).version = to;
for (const { consumer, field, dependency, to } of plan.dependencyEdits) manifests.get(consumer)[field][dependency] = to;

const touched = new Set([
  ...plan.targets.filter(({ from, to }) => from !== to).map(({ name }) => name),
  ...plan.dependencyEdits.map(({ consumer }) => consumer),
  // A committed but unpublished package may already have its planned version
  // in package.json.  Its lock root still has to declare that same future
  // dependency graph so the wave can verify it against pending artifacts.
  ...plan.changedNames,
]);
for (const name of touched) {
  const site = byName.get(name);
  const manifest = manifests.get(name);
  await writeFile(site.path, `${JSON.stringify(manifest, null, 2)}\n`);
  const lockPath = resolve(site.dir, "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  lock.version = manifest.version;
  if (lock.packages?.[""]) {
    lock.packages[""].version = manifest.version;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (manifest[field] && Object.keys(manifest[field]).length > 0) lock.packages[""][field] = { ...manifest[field] };
      else delete lock.packages[""][field];
    }
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

process.stdout.write(`prepared ${plan.targets.length} release package(s), ${plan.dependencyEdits.length} exact consumer edit(s); receipt ${reportPath ?? "not written"}\n`);
