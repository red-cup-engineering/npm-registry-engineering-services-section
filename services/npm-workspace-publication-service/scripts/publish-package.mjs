#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { listDirectoryEntries } from "@red-cup-engineering/computer-filepath-engineering-services-section/list-directory-entries";
import { executeJavascriptNodeCommand } from "@red-cup-engineering/execute-javascript-node-command-service";
import { readFileText } from "@red-cup-engineering/computer-file-engineering-services-section/read-file";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { dirname, resolve } from "node:path";
import { statPath } from "@red-cup-engineering/computer-file-engineering-services-section/stat-path";
import semver from "semver";
import { put } from "@red-cup-engineering/semiotic-eavt-services-section/store";
import { packageExportSurfacePaths } from "../src/carrier-surface.mjs";
import { classifyDistStaleness } from "../src/dist-staleness.mjs";
import { packageLockRootIdentityViolations, publicationManifest, WORKSPACE_SPECIFICATION } from "../src/dependency-policy.mjs";
import { scanWorkspacePackages } from "../src/read-workspace-manifests.mjs";
import { concreteJavascriptExportTargets } from "../src/export-subpath-targets.mjs";
import { classifyExportSurfaceDiff } from "../src/export-surface-diff.mjs";
import { parseFailingTestNames } from "../src/failing-test-names.mjs";
import { javascriptModuleExportedNames } from "../src/javascript-export-names.mjs";
import { classifyLockfileResolvedUrls } from "../src/lockfile-registry-classification.mjs";
import { npmPublicationArguments } from "../src/npm-publication-command.mjs";
import { buildPublishGateReceipt } from "../src/publish-gate-receipt.mjs";
import { readRegistryPackage } from "../src/registry.mjs";
import { checkRegistryLiveness } from "../src/registry-liveness.mjs";
import { assertHousePublicationVersion, classifyReleaseVersion, incrementReleaseBase, releaseBumpAllowsChange } from "../src/release-wave.mjs";
import { packedFiles } from "../src/tarball-guard.mjs";
import { parseTestRunSummary } from "../src/test-run-summary.mjs";
import { lastLines } from "../src/text-tail.mjs";
import { detectPackageManager, hasPackageManagerLockfile, packageManagerInstallCommand } from "../src/package-manager.mjs";

async function run(command, args, options = {}) {
  const receipt = executeJavascriptNodeCommand({
    type: "JavascriptNodeCommandExecutionRequest",
    version: 1,
    command,
    arguments: args,
    directory: options.cwd ?? process.cwd(),
    environment: options.env ? { ...options.env } : null,
    input: null,
  });
  const { result } = receipt;
  if (result.status !== 0 || result.signal !== null || result.error) {
    const error = new Error(result.error || `Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.code = result.status;
    error.signal = result.signal;
    throw error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
const CANONICAL_REGISTRY = "https://registry.561.group";

/**
 * These are names for operations inside the Node operating system, not
 * independently versioned distribution units.  Publishing or repinning one
 * preserves an architecture that the migration is removing.
 */
const NON_PACKAGE_OPERATION_NAMES = new Set(["fae", "fern", "frog", "relating"]);

/**
 * @param {unknown} packageName
 * @returns {string | null} The refusal reason, or null for a publishable package name.
 */
export function nonPackageOperationPublicationReason(packageName) {
  if (typeof packageName !== "string") return null;
  const localName = packageName.split("/").at(-1)?.toLowerCase();
  if (!NON_PACKAGE_OPERATION_NAMES.has(localName)) return null;
  return `${packageName} names an internal Node operating-system operation, not a publishable package; migrate its consumers into the operating-system application and remove the package boundary`;
}

/**
 * Purely classify whether one parsed consumer manifest can be repinned to a
 * provider. Keeping this separate from filesystem access makes the publish
 * gate refuse all bad consumer declarations before it changes a version or
 * publishes an immutable tarball.
 */
export function classifyRepinConsumerManifest({ consumerDir, manifest, packageName }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return Object.freeze({ consumerDir, ok: false, reason: "package.json must contain an object" });
  }
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    return Object.freeze({ consumerDir, ok: false, reason: "package.json must declare a non-empty name" });
  }
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .filter((field) => Object.hasOwn(manifest[field] ?? {}, packageName));
  if (fields.length === 0) {
    return Object.freeze({ consumerDir, ok: false, reason: `consumer does not depend on ${packageName}` });
  }
  if (fields.length > 1) {
    return Object.freeze({ consumerDir, ok: false, reason: `consumer declares ${packageName} in more than one dependency field`, fields: Object.freeze(fields) });
  }
  return Object.freeze({ consumerDir, ok: true, field: fields[0], packageName: manifest.name });
}

/** Read every requested consumer before the publication path begins. */
export async function preflightRepinConsumers({ repin, packageName }) {
  if (!Array.isArray(repin)) {
    return Object.freeze({ ok: false, consumers: Object.freeze([{ consumerDir: null, ok: false, reason: "repin must be an array of consumer directories" }]) });
  }
  const consumers = [];
  for (const consumerDir of repin) {
    if (typeof consumerDir !== "string" || consumerDir.length === 0) {
      consumers.push(Object.freeze({ consumerDir: null, ok: false, reason: "consumer directory must be a non-empty string" }));
      continue;
    }
    const resolvedConsumerDir = resolve(consumerDir);
    let directory;
    try {
      directory = await statPath({ path: resolvedConsumerDir });
    } catch (error) {
      consumers.push(Object.freeze({ consumerDir: resolvedConsumerDir, ok: false, reason: `cannot inspect consumer directory: ${error.message}` }));
      continue;
    }
    if (!directory.exists || directory.kind !== "directory") {
      consumers.push(Object.freeze({ consumerDir: resolvedConsumerDir, ok: false, reason: "consumer directory does not exist or is not a directory" }));
      continue;
    }
    try {
      const manifest = JSON.parse(await readFileText(resolve(resolvedConsumerDir, "package.json")));
      consumers.push(classifyRepinConsumerManifest({ consumerDir: resolvedConsumerDir, manifest, packageName }));
    } catch (error) {
      consumers.push(Object.freeze({ consumerDir: resolvedConsumerDir, ok: false, reason: `cannot read package.json: ${error.message}` }));
    }
  }
  return Object.freeze({ ok: consumers.every((consumer) => consumer.ok), consumers: Object.freeze(consumers) });
}

/** Raised to unwind the gate at the first refusal, carrying the refusal datum. */
class GateRefusal extends Error {
  constructor(step, reason, evidence) {
    super(reason);
    this.step = step;
    this.evidence = evidence ?? {};
  }
}

function commandFailure(error) {
  return [error?.stdout, error?.stderr, error?.message].map((part) => String(part ?? "").trim()).filter(Boolean).join(" | ");
}

async function runPackageTests(cwd) {
  try {
    const result = await run("npm", ["test", "--silent"], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, signal: null, commandError: null };
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: error.code ?? null, signal: error.signal ?? null, commandError: error.message };
  }
}

/**
 * Run `npm test` in `cwd` and parse its summary, or throw a `GateRefusal`
 * whose evidence names every failing test (parsed from the `not ok`/`✖`
 * lines, not merely counted) and carries the last 20 lines of stderr.
 */
export async function testSummaryOrRefuse(step, cwd) {
  const { stdout, stderr, exitCode, signal, commandError } = await runPackageTests(cwd);
  const combined = `${stdout}\n${stderr}`;
  const failureEvidence = () => ({ exitCode, signal, commandError, failingTests: parseFailingTestNames(combined), stderrTail: lastLines(stderr, 20) });
  let summary;
  try {
    summary = parseTestRunSummary(combined);
  } catch (parseError) {
    throw new GateRefusal(step, `npm test produced no parseable summary: ${parseError.message}`, failureEvidence());
  }
  if (exitCode !== 0 || signal !== null || commandError !== null) throw new GateRefusal(step, `npm test did not complete successfully (exit ${exitCode}, signal ${signal})`, { ...summary, ...failureEvidence() });
  if (summary.fail > 0) throw new GateRefusal(step, `tests failed: ${summary.fail} of ${summary.tests}`, { ...summary, ...failureEvidence() });
  return summary;
}

async function walkFiles(root, prefix = "") {
  const { entries } = await listDirectoryEntries({ root, path: prefix });
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") files.push(...await walkFiles(root, relativePath));
    else if (entry.kind === "file") files.push(relativePath);
  }
  return files;
}

function isExcludedFromStalenessComparison(relativePath) {
  const segments = relativePath.split("/");
  return segments.includes("node_modules") || segments.includes("test") || segments.includes("tests") || relativePath.includes(".test.");
}

async function filesWithMtimes(root, prefix) {
  let entries;
  try {
    ({ entries } = await listDirectoryEntries({ root, path: prefix }));
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isExcludedFromStalenessComparison(relativePath)) continue;
    if (entry.kind === "directory") files.push(...await filesWithMtimes(root, relativePath));
    else if (entry.kind === "file") {
      const info = await statPath({ path: resolve(root, relativePath) });
      files.push({ path: relativePath, mtimeMs: info.mtimeMs });
    }
  }
  return files;
}

/**
 * Gather the effectful file listings `classifyDistStaleness` needs: every
 * source file under `src/`, and every file under a `files` manifest entry
 * that names a directory (the built output — `dist`, typically). `src`
 * itself is never treated as built output, even when the manifest lists it,
 * so a package that ships its own sources is never compared against itself.
 * @param {string} packageDir Resolved package directory.
 * @param {{files?: readonly string[]}} manifest The package manifest.
 * @returns {Promise<{sourceFiles: readonly {path: string, mtimeMs: number}[], builtFiles: readonly {path: string, mtimeMs: number}[]}>}
 */
/** Build-output directories: every tsconfig*.json outDir in the package, plus `dist` by convention. */
async function buildOutputDirectories(packageDir) {
  const outputs = new Set(["dist"]);
  const { entries } = await listDirectoryEntries({ root: packageDir });
  for (const { name: entry } of entries) {
    if (!/^tsconfig.*\.json$/u.test(entry)) continue;
    try {
      const outDir = JSON.parse(await readFileText(resolve(packageDir, entry)))?.compilerOptions?.outDir;
      if (typeof outDir === "string" && outDir.length > 0) outputs.add(outDir.replace(/^\.\//u, "").replace(/\/$/u, ""));
    } catch {
      // a tsconfig that is not plain JSON (comments) contributes nothing; dist stays
    }
  }
  return outputs;
}

async function distStalenessListings(packageDir, manifest) {
  const sourceFiles = await filesWithMtimes(packageDir, "src");
  const builtFiles = [];
  const outputs = await buildOutputDirectories(packageDir);
  for (const entry of manifest.files ?? []) {
    // Only build outputs are compared against src: hand-authored shipped
    // content (content/, README) is legitimately older than the newest source.
    if (!outputs.has(entry.replace(/^\.\//u, "").replace(/\/$/u, ""))) continue;
    let info;
    try {
      info = await statPath({ path: resolve(packageDir, entry) });
    } catch {
      continue;
    }
    if (!info.exists) continue;
    if (info.kind === "directory") builtFiles.push(...await filesWithMtimes(packageDir, entry));
  }
  return { sourceFiles, builtFiles };
}

async function exportedNamesOrNull(filePath) {
  try {
    return javascriptModuleExportedNames(await readFileText(filePath)).names;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { repin: [], pin: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--package") args.package = argv[++index];
    else if (value === "--bump") args.bump = argv[++index];
    else if (value === "--apply") args.apply = true;
    else if (value === "--repin") args.repin.push(argv[++index]);
    else if (value === "--pin") args.pin.push(argv[++index]);
    else if (value === "--pin-only") args.pinOnly = true;
    else if (value === "--registry") args.registry = argv[++index];
    else if (value === "--help") args.help = true;
    else throw new Error(`unrecognized argument: ${value}`);
  }
  if (!args.help && !args.package) throw new Error("--package <dir> is required");
  if (args.bump !== undefined && !["patch", "minor", "major"].includes(args.bump)) {
    throw new Error("--bump must be patch, minor, or major");
  }
  for (const entry of args.pin) {
    if (!/^(@[^/@]+\/)?[^/@]+@.+$/u.test(entry)) throw new Error(`--pin must be <dependency-name>@<version>, got ${JSON.stringify(entry)}`);
  }
  if (args.pinOnly && (args.pin.length === 0 || !args.apply || args.bump !== undefined || args.repin.length > 0)) {
    throw new Error("--pin-only requires --apply and at least one --pin, and takes no --bump or --repin: it repins this package's own dependencies and refreshes its lockfile without publishing it");
  }
  return args;
}

function usage() {
  return "usage: publish-package --package <dir> [--bump patch|minor|major] [--apply] [--pin <dependency-name>@<version>]... [--pin-only] [--repin <consumer-dir>]... [--registry <url>]\n       --pin-only: apply the --pin entries to this package, refresh its lockfile and install tree, run its tests, and write a pin receipt, without bumping or publishing it.\n";
}

/**
 * Parses a `--pin` argument (`<dependency-name>@<version>`) into its name and version,
 * respecting a scoped name's own leading `@`.
 * @param {string} entry
 * @returns {{ name: string, version: string }}
 */
export function parsePinEntry(entry) {
  const at = entry.lastIndexOf("@");
  return Object.freeze({ name: entry.slice(0, at), version: entry.slice(at + 1) });
}

/**
 * Sets one already-declared dependency's version in a package's own manifest, then refreshes
 * that package's lockfile (an "update-lock" install, never "verify"/`npm ci`, since the
 * manifest just changed) so the gate's own fresh-install step never has to fail on a lockfile
 * this same operation just made stale. Exists because hand-editing a package.json's dependency
 * pin and forgetting the matching lockfile refresh was, before this, a manual step every caller
 * had to remember on every internal repin -- the exact class of friction this gate exists to
 * remove, not reproduce on itself.
 * @param {{ packageDir: string, name: string, version: string, registry: string, scratchRoot: string }} input
 * @returns {Promise<{ manifest: object, field: string }>} the manifest as re-read from disk after the refresh, and which dependency field carried the pin.
 */
export async function applyDependencyPin({ packageDir, name, version, registry, scratchRoot }) {
  const manifestPath = resolve(packageDir, "package.json");
  const manifest = JSON.parse(await readFileText(manifestPath));
  const field = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .find((candidate) => Object.hasOwn(manifest[candidate] ?? {}, name));
  if (!field) throw new GateRefusal(-3, `--pin ${name}: package does not already declare a dependency on it in any dependency field`, { packageDir, name });
  manifest[field][name] = version;
  await writeFileText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const install = await refreshConsumerInstall({ packageDir, manifest, registry, scratchRoot });
  const refreshedManifest = JSON.parse(await readFileText(manifestPath));
  return Object.freeze({ manifest: refreshedManifest, field, install });
}

/**
 * Refreshes one consumer's lockfile and install tree after its manifest pin changed: an
 * "update-lock" install against the registry through this release's isolated cache first, and,
 * only when that install fails, a second attempt through the consumer's own standing package
 * cache (`preferOffline`). The fallback exists for the reproduced 2026-09-11 failure: a consumer
 * whose transitive dependency tarball the registry no longer serves (a decommissioned package
 * still declared by an intermediate dependency) but whose cache still holds it. The mode taken
 * and the registry failure that forced it are returned so the receipt states them; a fallback
 * is evidence of a registry or dependency defect to repair, never a silent success.
 * @param {{ packageDir: string, manifest: object, registry: string, scratchRoot: string }} input
 * @returns {Promise<{ packageManager: string, installMode: "registry"|"offline-cache-fallback", registryFailure?: string }>}
 */
export async function refreshConsumerInstall({ packageDir, manifest, registry, scratchRoot }) {
  const { entries } = await listDirectoryEntries({ root: packageDir });
  const packageManager = detectPackageManager({ manifest, presentFiles: entries.map((entry) => entry.name) });
  await rm(resolve(packageDir, "node_modules"), { recursive: true, force: true });
  const online = packageManagerInstallCommand(packageManager, registry, "update-lock", { cacheRoot: scratchRoot });
  try {
    await run(online.command, [...online.arguments], { cwd: packageDir, maxBuffer: 64 * 1024 * 1024 });
    return Object.freeze({ packageManager, installMode: "registry" });
  } catch (error) {
    const registryFailure = commandFailure(error);
    const offline = packageManagerInstallCommand(packageManager, registry, "update-lock", { preferOffline: true });
    await run(offline.command, [...offline.arguments], { cwd: packageDir, maxBuffer: 64 * 1024 * 1024 });
    return Object.freeze({ packageManager, installMode: "offline-cache-fallback", registryFailure });
  }
}

/**
 * Change a package identity through npm so its package-lock root follows the
 * manifest without running lifecycle scripts or making a git tag.
 */
export async function bumpPackageVersion({ packageDir, toVersion }) {
  await run("npm", ["version", toVersion, "--no-git-tag-version", "--ignore-scripts"], { cwd: packageDir, maxBuffer: 64 * 1024 * 1024 });
  const manifestPath = resolve(packageDir, "package.json");
  const bumpedManifest = JSON.parse(await readFileText(manifestPath));
  if (bumpedManifest.version !== toVersion) throw new Error(`npm version wrote ${JSON.stringify(bumpedManifest.version)} instead of ${JSON.stringify(toVersion)}`);
  const lockPath = resolve(packageDir, "package-lock.json");
  if ((await statPath({ path: lockPath })).exists) {
    const lock = JSON.parse(await readFileText(lockPath));
    const violations = packageLockRootIdentityViolations(bumpedManifest, lock);
    if (violations.length > 0) throw new Error(`npm version left package-lock root identity stale: ${JSON.stringify(violations)}`);
  }
  return Object.freeze({ manifest: bumpedManifest, version: toVersion });
}

/**
 * Run the deterministic house publish gate against one package: registry
 * liveness, a build (when the manifest declares one — this
 * is the only step that actually runs `npm run build`, since publish and
 * pack both run with `--ignore-scripts`, and it refuses a still-stale
 * shipped output the same way it refuses a failed build), a fresh install
 * IN the package directory (per the skill literally — a scratch copy
 * breaks a suite that walks up from cwd to find the repo root), a version
 * check, a tarball diff against the currently published release (extracted
 * to a scratch copy), and — only with `apply: true` — the version bump,
 * `npm publish`, a fresh-install verify (also in a scratch copy), a
 * journal receipt, and any requested consumer repins. Stops at the first
 * refusal; every step already completed is still reported.
 * @param {object} options
 * @param {string} options.packageDir The package directory to gate.
 * @param {"patch"|"minor"|"major"} [options.bump] The release bump, required to publish an already-published version.
 * @param {boolean} [options.apply] Whether to actually bump, publish, verify, record, and repin.
 * @param {readonly string[]} [options.repin] Consumer directories to re-pin after a successful publish.
 * @param {readonly {name: string, version: string}[]} [options.pin] This package's own dependency pins to set (and lockfile-refresh) before the gate runs, so a caller that just published an upstream package never has to hand-edit this manifest and separately remember an `npm install` first.
 * @param {string} [options.registry] The canonical registry base URL.
 * @returns {Promise<object>} The full gate report, frozen and JSON-serializable.
 */
export async function publishPackageGate({ packageDir, bump, apply = false, repin = [], pin = [], pinOnly = false, registry = CANONICAL_REGISTRY }) {
  const startedAt = new Date().toISOString();
  const resolvedPackageDir = resolve(packageDir);
  const manifestPath = resolve(resolvedPackageDir, "package.json");
  let manifest = JSON.parse(await readFileText(manifestPath));
  assertHousePublicationVersion(manifest.name, manifest.version);
  const scope = manifest.name?.startsWith("@") ? manifest.name.split("/")[0] : undefined;
  const steps = [];
  let refusal = null;
  const state = { sourceVersion: manifest.version, toVersion: null };
  // An applying run finds the section that holds its receipt before anything is written: a run
  // that could not record its outcome must not publish an immutable version first.
  const receiptSection = apply ? await nearestServicesSectionWithData(resolvedPackageDir) : null;

  const scratchRoot = resolve(tmpdir(), `publish-package-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(scratchRoot, { recursive: true });

  let restoreSourceManifest = null;
  try {
    restoreSourceManifest = await wearPublishedManifest(manifestPath, resolvedPackageDir);
    if (restoreSourceManifest) manifest = JSON.parse(await readFileText(manifestPath));
    if (pin.length > 0) {
      const pinResults = [];
      for (const { name, version } of pin) {
        const { field, install } = await applyDependencyPin({ packageDir: resolvedPackageDir, name, version, registry, scratchRoot });
        pinResults.push({ name, version, field, ...install });
      }
      manifest = JSON.parse(await readFileText(manifestPath));
      steps.push({ step: -3, name: "apply-pins", ok: true, evidence: { pinResults } });
      if (pinOnly) {
        const testCount = await testSummaryOrRefuse(-3, resolvedPackageDir);
        const pinned = (testCount.fail ?? 1) === 0;
        const receipt = await writeReceipt({ sectionRoot: receiptSection, manifestName: manifest.name, action: "pin", state, toVersion: manifest.version, extra: { pins: pinResults, testCount } });
        steps.push({ step: 8, name: "receipt", ok: true, evidence: receipt });
        return finish({ outcome: pinned ? "pinned" : "pinned-with-test-failures", packageName: manifest.name, packageDir: resolvedPackageDir, startedAt, steps, refusal: null, state: { ...state, testCount } });
      }
    }

    const nonPackageReason = nonPackageOperationPublicationReason(manifest.name);
    if (nonPackageReason) throw new GateRefusal(-1, nonPackageReason, { packageName: manifest.name, operation: manifest.name.split("/").at(-1), requiredAction: "migrate-and-remove-package-boundary" });

    const repinPreflight = await preflightRepinConsumers({ repin, packageName: manifest.name });
    if (!repinPreflight.ok) throw new GateRefusal(-2, "consumer preflight refused one or more requested repins", repinPreflight);
    if (repin.length > 0) steps.push({ step: -2, name: "consumer-preflight", ok: true, evidence: repinPreflight });

    // Step 0: registry liveness.
    const liveness = await checkRegistryLiveness({ registry, scope, execFileImpl: run });
    if (!liveness.ok) throw new GateRefusal(0, liveness.reason, liveness.evidence);
    steps.push({ step: 0, name: "registry-liveness", ok: true, evidence: liveness.evidence });

    // Step 1: fresh install, before the build so a first publish (no node_modules yet) can
    // resolve its declared dependencies — per the skill literally, IN the package
    // directory, not a scratch copy. A scratch copy outside the repository
    // breaks any test suite that walks up from cwd to find the repo root
    // (observed: claude-harness-projection-service's suite passed 37/37 in
    // place and only 36/37 from a copy under /tmp). Installs with the
    // package's OWN package manager (npm, pnpm, or yarn — detected from its
    // manifest's `packageManager` field or its own committed lockfile),
    // never forcing npm on a package whose scripts assume something else.
    const { entries: topLevelEntries } = await listDirectoryEntries({ root: resolvedPackageDir });
    const presentFiles = topLevelEntries.map((entry) => entry.name);
    const packageManager = detectPackageManager({ manifest, presentFiles });
    const installMode = hasPackageManagerLockfile(packageManager, presentFiles) ? "verify" : "update-lock";
    const install = packageManagerInstallCommand(packageManager, registry, installMode, { cacheRoot: scratchRoot });
    try {
      await rm(resolve(resolvedPackageDir, "node_modules"), { recursive: true, force: true });
      await run(install.command, [...install.arguments], { cwd: resolvedPackageDir, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      throw new GateRefusal(1, `fresh install (${packageManager}) failed: ${commandFailure(error)}`, { packageManager });
    }
    const freshInstallLockfileCheck = packageManager === "npm"
      ? classifyLockfileResolvedUrls(JSON.parse(await readFileText(resolve(resolvedPackageDir, "package-lock.json"))), registry)
      : { resolvedTotal: 0, canonical: 0, notCanonicalRegistry: 0, houseScopedNotCanonical: 0, houseScopedNotCanonicalEntries: [], notApplicable: true, reason: `${packageManager}-lock carries no per-dependency resolved URL; registry routing is governed by --registry and the scope config every install already reads` };
    if (freshInstallLockfileCheck.houseScopedNotCanonical > 0) {
      throw new GateRefusal(1, `fresh install resolves ${freshInstallLockfileCheck.houseScopedNotCanonical} house-scoped dependency off the canonical registry`, freshInstallLockfileCheck);
    }
    steps.push({ step: 1, name: "fresh-install", ok: true, evidence: { packageManager, installMode, lockfile: freshInstallLockfileCheck } });
    state.freshInstallLockfileCheck = freshInstallLockfileCheck;


    // Step 2: build, when the manifest declares one, against the fresh install, then the tests — --ignore-scripts on
    // publish/pack means npm's own prepack never runs the build, so this
    // gate step is the only thing standing between a stale on-disk `dist/`
    // and a shipped tarball (observed in production:
    // @red-cup-engineering/metroplat@0.4.0 published an older `dist` than
    // its `src`). Not run with --ignore-scripts: it is the build.
    const buildScript = typeof manifest.scripts?.build === "string";
    let buildEvidence;
    if (!buildScript) {
      buildEvidence = { ran: false, reason: "no-build-script" };
    } else {
      try {
        await run("npm", ["run", "build"], { cwd: resolvedPackageDir, maxBuffer: 64 * 1024 * 1024, env: process.env });
      } catch (error) {
        throw new GateRefusal(2, `build-failed: npm run build failed: ${commandFailure(error)}`, { ran: true, stderrTail: lastLines(String(error.stderr ?? ""), 20) });
      }
      buildEvidence = { ran: true };
      const staleness = await distStalenessListings(resolvedPackageDir, manifest).then(classifyDistStaleness);
      buildEvidence.staleness = staleness;
      if (staleness.stale) {
        throw new GateRefusal(2, `dist-stale: shipped file ${staleness.oldestBuilt.path} is older than source file ${staleness.newestSource.path}`, staleness);
      }
    }
    const freshInstallTestCount = await testSummaryOrRefuse(2, resolvedPackageDir);
    buildEvidence.testCount = freshInstallTestCount;
    steps.push({ step: 2, name: "build", ok: true, evidence: buildEvidence });
    state.freshInstallTestCount = freshInstallTestCount;


    // Step 3: current version exists; target version (when bumping) is free.
    const packumentResult = await readRegistryPackage(registry, manifest.name);
    if (!packumentResult.reachable) throw new GateRefusal(3, `registry became unreachable while reading ${manifest.name}: ${registry}`, {});
    const firstPublish = !packumentResult.found;
    const publishedVersions = firstPublish ? [] : Object.keys(packumentResult.packument.versions ?? {});
    const previousVersion = firstPublish
      ? null
      : packumentResult.packument["dist-tags"]?.latest ?? [...publishedVersions].sort(semver.rcompare)[0] ?? null;
    const sourcePublished = publishedVersions.includes(manifest.version);
    const targetVersion = bump ? incrementReleaseBase(manifest.version, bump) : null;
    const targetPublished = targetVersion !== null && publishedVersions.includes(targetVersion);
    const versionEvidence = { sourceVersion: manifest.version, sourcePublished, previousVersion, firstPublish, bump: bump ?? null, targetVersion, targetPublished };
    if (apply) {
      if (!bump && sourcePublished) throw new GateRefusal(3, `package.json version ${manifest.version} is already published; --bump is required`, versionEvidence);
      if (bump && targetPublished) throw new GateRefusal(3, `target version ${targetVersion} is already published`, versionEvidence);
    }
    steps.push({ step: 3, name: "version-check", ok: true, evidence: versionEvidence });

    // Step 4: tarball diff against the currently published release.
    let tarballDiffClassification;
    let tarballDiffDetail;
    if (firstPublish) {
      tarballDiffClassification = "first-publish";
      tarballDiffDetail = { note: "no prior published version exists to diff against" };
    } else {
      const previousDir = resolve(scratchRoot, "previous");
      await mkdir(previousDir, { recursive: true });
      let packOutput;
      try {
        packOutput = await run("npm", ["pack", `${manifest.name}@${previousVersion}`, "--registry", registry, "--pack-destination", scratchRoot], { cwd: scratchRoot, maxBuffer: 64 * 1024 * 1024 });
      } catch (error) {
        throw new GateRefusal(4, `fetching published tarball ${manifest.name}@${previousVersion} failed: ${commandFailure(error)}`, {});
      }
      const tarballName = packOutput.stdout.trim().split("\n").at(-1);
      await run("tar", ["-xzf", resolve(scratchRoot, tarballName), "-C", previousDir, "--strip-components=1"]);
      const previousManifest = JSON.parse(await readFileText(resolve(previousDir, "package.json")));
      const previousFiles = await walkFiles(previousDir);
      const currentFiles = await packedFiles(resolvedPackageDir);
      const previousTargets = concreteJavascriptExportTargets(previousManifest);
      const currentTargetBySubpath = new Map(concreteJavascriptExportTargets(manifest).map(({ subpath, target }) => [subpath, target]));
      const exportDiffs = [];
      for (const { subpath, target } of previousTargets) {
        const previousNames = await exportedNamesOrNull(resolve(previousDir, target));
        const currentTarget = currentTargetBySubpath.get(subpath);
        const currentNames = currentTarget ? await exportedNamesOrNull(resolve(resolvedPackageDir, currentTarget)) : null;
        exportDiffs.push({ subpath, previousNames, currentNames });
      }
      const reachableFiles = packageExportSurfacePaths(previousManifest);
      const diff = classifyExportSurfaceDiff({ previousFiles, currentFiles, exportDiffs, reachableFiles });
      tarballDiffClassification = diff.classification;
      tarballDiffDetail = diff;
      if (tarballDiffClassification === "breaking" && !releaseBumpAllowsChange(manifest.version, bump, "breaking")) {
        const requiredBump = classifyReleaseVersion(manifest.version).major === 0 ? "minor" : "major";
        throw new GateRefusal(4, `tarball diff is breaking (${diff.removedFiles.length} file(s) removed, ${diff.missingExports.length} export(s) missing) but --bump ${requiredBump} was not given`, diff);
      }
    }
    steps.push({ step: 4, name: "tarball-diff", ok: true, evidence: { classification: tarballDiffClassification, previousVersion, detail: tarballDiffDetail } });
    state.tarballDiffClassification = tarballDiffClassification;

    if (!apply) {
      return finish({ outcome: "planned", packageName: manifest.name, packageDir: resolvedPackageDir, startedAt, steps, refusal: null, state });
    }

    // Step 5: bump the version.
    let toVersion = manifest.version;
    if (bump) {
      toVersion = incrementReleaseBase(manifest.version, bump);
      try {
        await bumpPackageVersion({ packageDir: resolvedPackageDir, toVersion });
      } catch (error) {
        throw new GateRefusal(5, `npm version failed: ${commandFailure(error)}`, { from: manifest.version, to: toVersion });
      }
    }
    steps.push({ step: 5, name: "version-bump", ok: true, evidence: { from: manifest.version, to: toVersion, bumped: toVersion !== manifest.version } });
    state.toVersion = toVersion;

    // Step 6: publish.
    try {
      const publishArguments = npmPublicationArguments({ name: manifest.name, version: toVersion }, registry, undefined);
      await run("npm", publishArguments, { cwd: resolvedPackageDir, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      throw new GateRefusal(6, `npm publish failed: ${commandFailure(error)}`, {});
    }
    steps.push({ step: 6, name: "publish", ok: true, evidence: { package: manifest.name, version: toVersion, registry } });

    // Step 7: fresh-install verify from the registry, importing every exports subpath.
    const verifyDir = resolve(scratchRoot, "verify");
    await mkdir(verifyDir, { recursive: true });
    await writeFileText(resolve(verifyDir, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`);
    try {
      await run("npm", ["install", `${manifest.name}@${toVersion}`, "--registry", registry, "--cache", resolve(scratchRoot, "npm"), "--prefer-online"], { cwd: verifyDir, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      throw new GateRefusal(7, `fresh-install verify install failed: ${commandFailure(error)}`, {});
    }
    const specifiers = concreteJavascriptExportTargets(manifest).map(({ subpath }) => (subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`));
    const importCode = `const out = {}; for (const specifier of ${JSON.stringify(specifiers)}) { out[specifier] = Object.keys(await import(specifier)); } process.stdout.write(JSON.stringify(out));`;
    let importedExports;
    try {
      const importResult = await run(process.execPath, ["--input-type=module", "-e", importCode], { cwd: verifyDir, maxBuffer: 8 * 1024 * 1024 });
      importedExports = JSON.parse(importResult.stdout);
    } catch (error) {
      throw new GateRefusal(7, `fresh-install verify import failed: ${commandFailure(error)}`, {});
    }
    steps.push({ step: 7, name: "fresh-install-verify", ok: true, evidence: { imported: importedExports } });

    // Step 8: receipt.
    const receipt = await writeReceipt({ sectionRoot: receiptSection, manifestName: manifest.name, action: "publish", state, toVersion });
    steps.push({ step: 8, name: "receipt", ok: true, evidence: receipt });

    // Step 9: re-pin each requested consumer.
    const repinResults = [];
    for (const consumerDir of repin) {
      const resolvedConsumerDir = resolve(consumerDir);
      const consumerManifestPath = resolve(resolvedConsumerDir, "package.json");
      let consumerManifest;
      try {
        consumerManifest = JSON.parse(await readFileText(consumerManifestPath));
      } catch (error) {
        repinResults.push({ consumerDir: resolvedConsumerDir, ok: false, reason: `cannot read package.json: ${error.message}` });
        continue;
      }
      const field = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
        .find((candidate) => Object.hasOwn(consumerManifest[candidate] ?? {}, manifest.name));
      if (!field) {
        repinResults.push({ consumerDir: resolvedConsumerDir, ok: false, reason: `consumer does not depend on ${manifest.name}` });
        continue;
      }
      consumerManifest[field][manifest.name] = toVersion;
      await writeFileText(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);
      try {
        const install = await refreshConsumerInstall({ packageDir: resolvedConsumerDir, manifest: consumerManifest, registry, scratchRoot });
        const consumerTestCount = await testSummaryOrRefuse(9, resolvedConsumerDir);
        repinResults.push({ consumerDir: resolvedConsumerDir, ok: (consumerTestCount.fail ?? 1) === 0, field, toVersion, ...install, testCount: consumerTestCount });
      } catch (error) {
        repinResults.push({ consumerDir: resolvedConsumerDir, ok: false, reason: commandFailure(error) });
      }
    }
    if (repin.length > 0) steps.push({ step: 9, name: "repin", ok: repinResults.every((entry) => entry.ok), evidence: repinResults });

    const repinFailed = repinResults.some((entry) => !entry.ok);
    return finish({ outcome: repinFailed ? "published-with-repin-failures" : "published", packageName: manifest.name, packageDir: resolvedPackageDir, startedAt, steps, refusal: null, state: { ...state, toVersion } });
  } catch (error) {
    if (!(error instanceof GateRefusal)) throw error;
    refusal = { step: error.step, reason: error.message, evidence: error.evidence };
    steps.push({ step: error.step, name: stepName(error.step), ok: false, evidence: error.evidence, reason: error.message });
    if (apply) {
      const receipt = await writeReceipt({ sectionRoot: receiptSection, manifestName: manifest.name, action: "refusal", state, toVersion: state.toVersion, extra: { refusalStep: error.step, refusalReason: error.message } });
      steps.push({ step: 8, name: "receipt", ok: true, evidence: receipt });
    }
    return finish({ outcome: "refused", packageName: manifest.name, packageDir: resolvedPackageDir, startedAt, steps, refusal, state });
  } finally {
    if (restoreSourceManifest) await restoreSourceManifest();
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
  }
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** The nearest directory at or above `dir` holding pnpm-workspace.yaml: the workspace the package is a sibling in. */
function workspaceRootOf(dir) {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(resolve(at, "pnpm-workspace.yaml"))) return at;
    if (dirname(at) === at) return null;
  }
}

/**
 * The package carries its published manifest while the gate runs (installed, tested, packed and
 * published as it is published: every workspace:* sibling at its exact version), and gets its
 * source manifest back after, keeping what the gate itself changed (a bumped version, requested pins).
 * Returns the restore, or null for a package that names no workspace sibling.
 */
async function wearPublishedManifest(manifestPath, packageDir) {
  const source = JSON.parse(await readFileText(manifestPath));
  const siblings = DEPENDENCY_FIELDS.flatMap((field) => Object.entries(source[field] ?? {}).filter(([, specification]) => specification === WORKSPACE_SPECIFICATION).map(([name]) => [field, name]));
  if (siblings.length === 0) return null;
  const root = workspaceRootOf(packageDir);
  if (root === null) throw new GateRefusal(-1, "the package names workspace siblings (workspace:*) but sits in no pnpm workspace", { siblings });
  const packages = await scanWorkspacePackages(root);
  const versionOf = (name) => { const sites = packages.filter((entry) => entry.name === name); return sites.length === 1 ? sites[0].version : undefined; };
  let published;
  try { published = publicationManifest(source, versionOf); } catch (error) { throw new GateRefusal(-1, error.message, { siblings }); }
  await writeFileText(manifestPath, `${JSON.stringify(published, null, 2)}\n`);
  return async () => {
    const current = JSON.parse(await readFileText(manifestPath));
    for (const [field, name] of siblings) if (current[field]?.[name] === published[field][name]) current[field][name] = WORKSPACE_SPECIFICATION;
    await writeFileText(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
  };
}

function stepName(step) {
  if (step === -3) return "apply-pins";
  if (step === -2) return "consumer-preflight";
  if (step === -1) return "package-boundary";
  return ["registry-liveness", "fresh-install", "build", "version-check", "tarball-diff", "version-bump", "publish", "fresh-install-verify", "receipt", "repin"][step] ?? `step-${step}`;
}

function finish({ outcome, packageName, packageDir, startedAt, steps, refusal, state }) {
  return Object.freeze({
    package: packageName,
    packageDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome,
    steps: Object.freeze(steps),
    refusal,
    state: Object.freeze({ ...state }),
  });
}

/** The store type the publish gate's receipts are held under. */
const PUBLISH_RECEIPT_TYPE = "package-publish-receipt";

async function writeReceipt({ sectionRoot, manifestName, action, state, toVersion, extra = {} }) {
  const record = buildPublishGateReceipt({
    package: manifestName,
    action,
    date: new Date().toISOString().slice(0, 10),
    fromVersion: state.sourceVersion,
    toVersion: toVersion ?? null,
    freshInstallTestCount: state.freshInstallTestCount ?? { tests: 0, pass: 0, fail: 0 },
    freshInstallLockfileCheck: state.freshInstallLockfileCheck ?? {},
    tarballDiffClassification: state.tarballDiffClassification ?? "first-publish",
    extra,
  });
  // A receipt is told for when the package was published and against when it was refused; `told` is a member only when it is not plainly for.
  const held = action === "publish" ? record : { ...record, told: { for: false, against: action === "refusal" } };
  return { id: put(sectionRoot, PUBLISH_RECEIPT_TYPE, held), sectionRoot };
}

async function nearestServicesSectionWithData(startDir) {
  let directory = resolve(startDir);
  while (true) {
    const parent = resolve(directory, "..");
    if (directory.endsWith("-services-section")) {
      try {
        await listDirectoryEntries({ root: directory, path: "data" });
        return directory;
      } catch { /* keep walking up */ }
    }
    if (parent === directory) throw new Error(`no ancestor *-services-section carrying data/ was found above ${startDir}`);
    directory = parent;
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    process.exitCode = 0;
  } else {
    publishPackageGate({
      packageDir: args.package,
      bump: args.bump,
      apply: Boolean(args.apply),
      repin: args.repin,
      pin: args.pin.map(parsePinEntry),
      pinOnly: Boolean(args.pinOnly),
      registry: args.registry ?? CANONICAL_REGISTRY,
    })
      .then((report) => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.exitCode = report.outcome === "published" || report.outcome === "planned" || report.outcome === "pinned" ? 0 : 2;
      })
      .catch((error) => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
