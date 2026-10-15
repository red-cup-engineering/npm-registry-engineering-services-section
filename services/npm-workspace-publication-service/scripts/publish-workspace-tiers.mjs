#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { workspaceDependencyClosure, leafFirstTiers } from "../src/workspace-graph.mjs";
import { scanWorkspaceManifests, scanWorkspacePackages } from "../src/read-workspace-manifests.mjs";
import { dependencyContractViolations, dependencySpecificationViolations, publicationManifest } from "../src/dependency-policy.mjs";
import { manifestRole, semanticVersionPolicyViolations } from "../src/semantic-version-policy.mjs";
import { secretBearingPaths } from "../src/tarball-guard.mjs";
import { isVersionPublished, readRegistryDistTag, readRegistryStorageDistTag, readRegistryStorageVersions, repairStorageTarballURL } from "../src/registry.mjs";
import { verifyIsolatedCarrier } from "../src/isolated-carrier-verification.mjs";
import { npmPublicationArguments } from "../src/npm-publication-command.mjs";
import { publicationTagForVersion } from "../src/release-wave.mjs";

// Sibling package under the same npm-registry-services-section: this tool
// publishes with the real npm client, which is known to self-report a
// corrupted dist.tarball URL for scoped packages against this registry (see
// tarball-guard.mjs). Default to the registry's own storage directory so
// every publish self-heals without the caller having to know this path.
const DEFAULT_STORAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "verdaccio-services-section", "data", "storage");

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const opts = (name) => args.flatMap((argument, index) => argument === name && args[index + 1] !== undefined ? [args[index + 1]] : []);

const root = opt("--root", process.cwd());
const registry = opt("--registry", "https://registry.561.group/");
const publishRegistry = opt("--publish-registry", registry);
const registryStorage = opt("--registry-storage", null);
const repairStorageRoot = registryStorage ?? DEFAULT_STORAGE_ROOT;
const artifactConcurrency = Number.parseInt(opt("--artifact-concurrency", "2"), 10);
const filter = opt("--filter", null);
const packageNames = opts("--package");
const execute = flag("--execute");
const preflightOnly = flag("--preflight");
const verify = flag("--verify");
const requestedTag = opt("--tag", undefined);
if (execute && preflightOnly) throw new Error("--execute and --preflight are mutually exclusive");
if (!Number.isSafeInteger(artifactConcurrency) || artifactConcurrency < 1) throw new TypeError("--artifact-concurrency must be a positive integer");

if (flag("--help")) {
  process.stderr.write(
    "usage: publish-workspace-tiers [--root <dir>] [--registry <read-url>] [--publish-registry <write-url>] [--registry-storage <dir>] [--artifact-concurrency <n>] [--filter <name-prefix> | --package <name>...] [--tag <npm-tag>] [--preflight | --execute] [--verify]\n" +
    "Dry-run by default: prints the leaf-first publication plan. --execute publishes each\n" +
    "unpublished package with npm. --package selects each named package and its local\n" +
    "dependency closure. Every manifest must already contain exact registry versions.\n" +
    "--preflight checks every manifest, then installs every pending package into an\n" +
    "isolated copy, runs its lifecycle, and checks its final tarball without publishing.\n" +
    "--execute uses the same globally verified copies, so no registry write begins until\n" +
    "every pending package has passed. --verify is retained as a compatibility flag.\n",
  );
  process.exit(2);
}

const sites = await scanWorkspaceManifests(root);
const packages = await scanWorkspacePackages(root);
if (filter !== null && packageNames.length > 0) throw new Error("--filter and --package are mutually exclusive");
const selected = packageNames.length > 0
  ? workspaceDependencyClosure(packages, packageNames)
  : filter === null ? packages : packages.filter((entry) => entry.name.startsWith(filter));
const { tiers, cyclic } = leafFirstTiers(selected);
const byName = new Map(selected.map((entry) => [entry.name, entry]));
const selectedNames = new Set(selected.map(({ name }) => name));
const policySites = sites.filter(({ manifest }) => {
  const name = manifest?.name;
  if (packageNames.length > 0) return selectedNames.has(name) || packageNames.includes(name);
  if (filter !== null) return typeof name === "string" && name.startsWith(filter);
  return true;
});

const plan = [];
for (const [index, tier] of tiers.entries()) {
  for (const name of tier) {
    const entry = byName.get(name);
    plan.push({ tier: index, name: entry.name, version: entry.version, dir: entry.dir, published: null, reachable: null });
  }
}
const unchecked = [...plan];
const storedVersions = registryStorage
  ? await readRegistryStorageVersions(registryStorage, unchecked.map(({ name }) => name))
  : null;
if (storedVersions) {
  for (const entry of unchecked) {
    entry.published = storedVersions.get(entry.name)?.has(entry.version) ?? false;
    entry.reachable = true;
  }
} else {
  await Promise.all(Array.from({ length: Math.min(2, unchecked.length) }, async () => {
    while (unchecked.length > 0) {
      const entry = unchecked.pop();
      const { published, reachable } = await isVersionPublished(publishRegistry, entry.name, entry.version);
      entry.published = published;
      entry.reachable = reachable;
    }
  }));
}

const pending = plan.filter((entry) => !entry.published);
const occupiedIdentities = new Set(plan.filter((entry) => entry.published).map(({ name, version }) => `${name}\u0000${version}`));
for (const entry of pending) entry.publicationTag = publicationTagForVersion(entry.version, requestedTag);
process.stderr.write(`packages: ${selected.length}  tiers: ${tiers.length}  already published: ${plan.length - pending.length}  pending: ${pending.length}  cyclic (excluded): ${cyclic.length}\n`);
if (cyclic.length > 0) process.stderr.write(`cycle members: ${cyclic.join(", ")}\n`);

if (!execute && !preflightOnly) {
  process.stdout.write(JSON.stringify({ registry, publishRegistry, plan, cyclic }, null, 2) + "\n");
  process.exit(pending.length > 0 || cyclic.length > 0 ? 1 : 0);
}

if (plan.some((entry) => !entry.reachable)) {
  throw new Error(`publication registry is unreachable: ${publishRegistry}`);
}

const pendingIdentities = new Set(pending.map(({ name, version }) => `${name}\u0000${version}`));
const availability = new Map();
async function dependencyIsPublished(name, version) {
  const identity = `${name}\u0000${version}`;
  if (!availability.has(identity)) {
    if (registryStorage) {
      if (!storedVersions.has(name)) {
        const one = await readRegistryStorageVersions(registryStorage, [name]);
        storedVersions.set(name, one.get(name) ?? new Set());
      }
      availability.set(identity, { published: storedVersions.get(name).has(version), reachable: true });
    } else {
      availability.set(identity, await isVersionPublished(registry, name, version));
    }
  }
  return availability.get(identity);
}

async function preflightManifestEntry(entry) {
  if (entry.published) return;
  const source = byName.get(entry.name);
  if (!source || source.version !== entry.version) throw new Error(`publication source disappeared for ${entry.name}@${entry.version}`);
  // The source names siblings as workspace:*; what is published names exact versions only.
  const published = publicationManifest(source.manifest);
  const violations = dependencySpecificationViolations(published, { published: true });
  if (violations.length > 0) {
    const error = new Error(`manifest has ${violations.length} non-exact dependency specification(s)`);
    error.evidence = { violations };
    throw error;
  }
  try {
    const lock = JSON.parse(await readFile(join(source.dir, "package-lock.json"), "utf8"));
    const pendingDirectDependencyIdentities = new Set(
      Object.entries(published.dependencies ?? {})
        .map(([name, version]) => `${name}\u0000${version}`)
        .filter((identity) => pendingIdentities.has(identity)),
    );
    const lockViolations = dependencyContractViolations(published, lock).filter((violation) => {
      // The isolated verifier installs a verified tarball for every pending
      // in-wave dependency.  Before publication, npm cannot resolve that
      // future version from the registry, so an older lock *resolution* is
      // expected.  The root specification must still match the manifest and
      // every non-wave dependency remains fully pinned and checked.
      const pending = typeof violation.name === "string"
        && typeof violation.manifestSpecification === "string"
        && pendingIdentities.has(`${violation.name}\u0000${violation.manifestSpecification}`);
      if (pending && violation.reason.startsWith("package-lock direct resolution")) return false;
      // A pending direct tarball replaces the prior install tree wholesale.
      // Its nested lock records are evidence about the old tarball, not the
      // prospective one, and are re-derived in verifyIsolatedCarrier before
      // any publish.  Never waive root or direct assertions here.
      if (pendingDirectDependencyIdentities.size > 0 && typeof violation.location === "string" && violation.location !== ""
        && violation.reason === "Node-resolved lock entry version must equal the exact dependency edge") return false;
      return true;
    });
    if (lockViolations.length > 0) {
      const error = new Error(`package lock has ${lockViolations.length} stale dependency assertion(s)`);
      error.evidence = { lockfile: join(source.dir, "package-lock.json"), violations: lockViolations };
      throw error;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, version] of Object.entries(published[field] ?? {})) {
      const identity = `${name}\u0000${version}`;
      if (pendingIdentities.has(identity)) continue;
      const check = await dependencyIsPublished(name, version);
      if (!check.reachable) throw new Error(`registry became unreachable while checking ${name}@${version}`);
      if (!check.published) throw new Error(`dependency is absent from registry and publication set: ${name}@${version}`);
    }
  }
}

async function preflightArtifactEntry(entry) {
  const leaking = await secretBearingPaths(entry.dir);
  if (leaking.length > 0) throw new Error(`secret-bearing tarball: ${leaking.join(", ")}`);
}

async function runGlobalPreflight(kind, entries, preflight, { failFast = false, concurrency = 1 } = {}) {
  const failures = [];
  let cursor = 0;
  let checked = 0;
  let stopped = false;
  async function worker() {
    while (!stopped && cursor < entries.length) {
      const entry = entries[cursor++];
      try {
        await preflight(entry);
      } catch (error) {
        const reason = String(error?.message ?? error);
        failures.push({ ...entry, phase: kind, reason, ...(error?.evidence === undefined ? {} : { evidence: error.evidence }) });
        process.stderr.write(`${entry.name}@${entry.version}: ${kind}-preflight-refused: ${reason}\n`);
        if (failFast) stopped = true;
      } finally {
        checked += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  process.stderr.write(`${kind} preflight: ${checked - failures.length} passed, ${failures.length} refused, ${entries.length - checked} unchecked\n`);
  return failures;
}

const policyFailures = [];
for (const site of policySites) {
  if (occupiedIdentities.has(`${site.manifest?.name}\u0000${site.manifest?.version}`)) continue;
  const role = manifestRole(site.manifest);
  let lock;
  try {
    lock = JSON.parse(await readFile(join(site.dir, "package-lock.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      policyFailures.push({ name: site.manifest?.name ?? site.path, version: site.manifest?.version ?? null, phase: "semantic-version-policy", reason: "package-lock.json is not valid JSON", evidence: { path: join(site.dir, "package-lock.json") } });
      continue;
    }
  }
  const violations = semanticVersionPolicyViolations(site.manifest, lock);
  if (violations.length > 0) policyFailures.push({ name: site.manifest?.name ?? site.path, version: site.manifest?.version ?? null, phase: "semantic-version-policy", reason: `semantic version policy has ${violations.length} violation(s)`, evidence: { path: site.path, role, violations } });
}
let preflightFailures = policyFailures;
if (preflightFailures.length === 0) preflightFailures = await runGlobalPreflight("manifest", plan, preflightManifestEntry);
if (preflightFailures.length === 0) preflightFailures = await runGlobalPreflight("artifact", pending, preflightArtifactEntry, { failFast: true, concurrency: artifactConcurrency });
const verifiedArtifacts = new Map();
const pendingDependencyArtifacts = new Map();
if (preflightFailures.length === 0) {
  for (const entry of pending) {
    try {
      const source = byName.get(entry.name);
      const verified = await verifyIsolatedCarrier({ sourceDir: entry.dir, manifest: source.manifest, registry, dependencyArtifacts: pendingDependencyArtifacts });
      verifiedArtifacts.set(entry.name, verified);
      pendingDependencyArtifacts.set(`${entry.name}\u0000${entry.version}`, verified.artifact);
      process.stderr.write(`${entry.name}@${entry.version}: lifecycle-preflight-passed\n`);
    } catch (error) {
      const reason = [error.stderr, error.stdout, error.message].map((part) => String(part ?? "").trim()).filter((part) => part !== "").join(" | ");
      preflightFailures.push({ ...entry, phase: "lifecycle", reason: reason.slice(-12_000), ...(error?.evidence === undefined ? {} : { evidence: error.evidence }) });
      process.stderr.write(`${entry.name}@${entry.version}: lifecycle-preflight-refused\n`);
    }
  }
  process.stderr.write(`lifecycle preflight: ${pending.length - preflightFailures.length} passed, ${preflightFailures.length} refused, 0 unchecked\n`);
}
if (preflightFailures.length > 0) {
  await Promise.all([...verifiedArtifacts.values()].map(({ cleanup }) => cleanup()));
  process.stdout.write(JSON.stringify({ registry, publishRegistry, outcome: "global-preflight-refused", failures: preflightFailures, cyclic }, null, 2) + "\n");
  process.exit(1);
}
if (preflightOnly) {
  await Promise.all([...verifiedArtifacts.values()].map(({ cleanup }) => cleanup()));
  process.stdout.write(JSON.stringify({ registry, publishRegistry, outcome: "global-preflight-passed", pending, cyclic }, null, 2) + "\n");
  process.exit(cyclic.length === 0 ? 0 : 1);
}

async function publishEntry(entry, publicationDir = entry.dir) {
  await run("npm", npmPublicationArguments(entry, publishRegistry, entry.publicationTag), { cwd: publicationDir });
  // The npm client observed publishing to this registry self-reports a
  // corrupted dist.tarball URL for scoped packages (see tarball-guard.mjs);
  // repair the just-published version's storage metadata immediately so no
  // published release is ever left 404ing on its own tarball fetch.
  try {
    const repair = await repairStorageTarballURL(repairStorageRoot, entry.name, entry.version);
    if (repair.changed) process.stderr.write(`${entry.name}@${entry.version}: repaired corrupted dist.tarball URL\n`);
  } catch (error) {
    process.stderr.write(`${entry.name}@${entry.version}: dist.tarball repair skipped: ${error?.message ?? error}\n`);
  }
}

async function publishedAfterWrite(entry) {
  if (!registryStorage) {
    const [identity, tag] = await Promise.all([
      isVersionPublished(publishRegistry, entry.name, entry.version),
      readRegistryDistTag(publishRegistry, entry.name, entry.publicationTag),
    ]);
    return Object.freeze({ ...identity, taggedVersion: tag.version });
  }
  const [versions, tag] = await Promise.all([
    readRegistryStorageVersions(registryStorage, [entry.name]),
    readRegistryStorageDistTag(registryStorage, entry.name, entry.publicationTag),
  ]);
  return Object.freeze({ published: versions.get(entry.name)?.has(entry.version) ?? false, reachable: true, taggedVersion: tag.version });
}

const results = [];
for (const tier of [...new Set(pending.map(({ tier }) => tier))].sort((left, right) => left - right)) {
  const tierEntries = pending.filter((entry) => entry.tier === tier);
  for (const entry of tierEntries) {
    try {
      await publishEntry(entry, verifiedArtifacts.get(entry.name).publicationDir);
      const check = await publishedAfterWrite(entry);
      const outcome = check.published && check.taggedVersion === entry.version
        ? "published-and-verified"
        : check.published ? "published-with-tag-mismatch" : "published-but-unverified";
      results.push({ ...entry, taggedVersion: check.taggedVersion, outcome });
      process.stderr.write(`${entry.name}@${entry.version}: ${results.at(-1).outcome}\n`);
    } catch (error) {
      const reason = [error.stderr, error.stdout, error.message].map((part) => String(part ?? "").trim()).filter((part) => part !== "").join(" | ");
      results.push({ ...entry, outcome: "refused", reason: reason.slice(-8_000) });
      process.stderr.write(`${entry.name}@${entry.version}: refused\n`);
    }
  }
}
await Promise.all([...verifiedArtifacts.values()].map(({ cleanup }) => cleanup()));
process.stdout.write(JSON.stringify({ registry, publishRegistry, results, cyclic }, null, 2) + "\n");
process.exit(results.length === pending.length && results.every((entry) => entry.outcome === "published-and-verified") && cyclic.length === 0 ? 0 : 1);
