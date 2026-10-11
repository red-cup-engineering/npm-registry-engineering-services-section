import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { lifecycleScripts } from "./software-estate.mjs";
import { carrierSurfaceViolations } from "./carrier-surface.mjs";
import { packedFiles, SECRET_PATH, secretBearingContentPaths } from "./tarball-guard.mjs";
import { verificationCopyFilter } from "./verification-copy.mjs";
import { dependencySpecificationViolations, publicationManifest } from "./dependency-policy.mjs";

const run = promisify(execFile);
const MODULE_GRAPH_ASSAY = join(dirname(fileURLToPath(import.meta.url)), "../scripts/assay-carrier-module-graph.mjs");

export function publicationTemporaryRoot(environment = process.env, platform = process.platform) {
  const configured = environment.NPM_PUBLICATION_TEMP_ROOT;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error("NPM_PUBLICATION_TEMP_ROOT must be absolute");
    return configured;
  }
  // Codex Desktop can carry Windows TEMP through WSL. Node then places a Linux
  // npm verification graph on /mnt/c, where metadata-heavy installs are both
  // slow and semantically the wrong execution substrate. Use the native Linux
  // temporary filesystem unless an operator explicitly binds another root.
  return platform === "linux" ? "/tmp" : tmpdir();
}

function concreteEntrypointSpecifiers(manifest) {
  const exports = manifest?.exports;
  if (exports === undefined) return manifest?.main === undefined ? [] : [manifest.name];
  if (typeof exports === "string" || Array.isArray(exports)) return [manifest.name];
  if (exports === null || typeof exports !== "object") return [];
  const keys = Object.keys(exports);
  if (keys.every((key) => !key.startsWith("."))) return [manifest.name];
  return keys.filter((key) => (key === "." || key.startsWith("./")) && !key.includes("*")).map((key) => key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`);
}

async function resolvePackedEntrypoints({ root, artifact, manifest }) {
  const consumer = join(root, "consumer");
  const installed = join(consumer, "node_modules", ...manifest.name.split("/"));
  await mkdir(installed, { recursive: true });
  await writeFile(join(consumer, "package.json"), '{"type":"module","private":true}\n');
  await run("tar", ["-xzf", artifact, "-C", installed, "--strip-components=1"]);
  const specifiers = concreteEntrypointSpecifiers(manifest);
  if (specifiers.length > 0) await run(process.execPath, ["--input-type=module", "--eval", `for (const specifier of ${JSON.stringify(specifiers)}) import.meta.resolve(specifier);`], { cwd: consumer });
  try {
    await run(process.execPath, ["--experimental-vm-modules", MODULE_GRAPH_ASSAY, "--root", installed, "--manifest", join(installed, "package.json")]);
  } catch (cause) {
    let evidence = null;
    try { evidence = JSON.parse(String(cause?.stdout ?? "")); } catch { /* bounded command evidence remains in the cause. */ }
    const error = new Error("packed carrier module graph is not closed", { cause });
    if (evidence !== null) error.evidence = evidence;
    throw error;
  }
}

/**
 * `versionOf(name)` is a workspace sibling's version: the carrier is the package as it is published,
 * so its manifest names every `workspace:*` sibling by that exact version (dependency-policy
 * `publicationManifest`) before anything is installed, verified or packed from it.
 */
export async function verifyIsolatedCarrier({ sourceDir, manifest, registry, versionOf = () => undefined, dependencyArtifacts = new Map(), npmEnvironment = {} }) {
  const root = await mkdtemp(join(publicationTemporaryRoot(), "npm-publication-"));
  const trace = (phase) => { if (process.env.NPM_PUBLICATION_TRACE === "1") process.stderr.write(`${manifest.name}@${manifest.version}: carrier-${phase}\n`); };
  const publicationDir = join(root, "package");
  try {
    trace("copy-started");
    await cp(sourceDir, publicationDir, { recursive: true, filter: verificationCopyFilter });
    const commandOptions = { cwd: publicationDir, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...npmEnvironment } };
    const manifestPath = join(publicationDir, "package.json");
    const published = publicationManifest(JSON.parse(await readFile(manifestPath, "utf8")), versionOf);
    const contract = dependencySpecificationViolations(published, { published: true });
    if (contract.length > 0) throw Object.assign(new Error(`published contract is not exact: ${contract.map(({ name, specification }) => `${name}@${specification}`).join(", ")}`), { evidence: contract });
    await writeFile(manifestPath, `${JSON.stringify(published, null, 2)}\n`);
    const manifestBytes = await readFile(manifestPath);
    const installationManifest = JSON.parse(manifestBytes);
    let hasPendingDependency = false;
    let requiresRegistry = false;
    const declaredNames = new Set();
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(installationManifest[field] ?? {})) {
        declaredNames.add(name);
        const artifact = dependencyArtifacts.get(`${name}\u0000${version}`);
        if (artifact === undefined) { requiresRegistry = true; continue; }
        installationManifest[field][name] = `file:${artifact}`;
        hasPendingDependency = true;
      }
    }
    // A retained lower-tier tarball may itself name another pending identity.
    // Bind those transitive identities to their already-verified artifacts as
    // installation-only overrides. Merely adding them as root dev dependencies
    // does not constrain npm's nested resolution and can still trigger a remote
    // lookup for an identity that lawfully has not been published yet. The
    // original source manifest is restored before lifecycle and packing.
    for (const [identity, artifact] of dependencyArtifacts) {
      const [name] = identity.split("\u0000");
      if (declaredNames.has(name)) continue;
      installationManifest.overrides ??= {};
      installationManifest.overrides[name] = `file:${artifact}`;
      hasPendingDependency = true;
    }
    if (hasPendingDependency) await writeFile(manifestPath, `${JSON.stringify(installationManifest, null, 2)}\n`);
    // The registry is an explicit admitted dependency. Do not let npm's default
    // exponential fetch retries turn one unavailable identity into an unbounded
    // carrier assay; the release coordinator can rerun after liveness returns.
    trace("install-started");
    await run("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", "--no-update-notifier", "--fetch-retries=0", "--fetch-timeout=5000", ...(!requiresRegistry ? ["--offline"] : []), "--registry", registry], commandOptions);
    trace("install-completed");
    if (hasPendingDependency) await writeFile(manifestPath, manifestBytes);
    for (const script of lifecycleScripts(manifest)) {
      trace(`lifecycle-${script}-started`);
      await run("npm", ["run", script], commandOptions);
    }
    trace("lifecycle-completed");
    const packedPaths = await packedFiles(publicationDir);
    const leaking = packedPaths.filter((path) => SECRET_PATH.test(path));
    if (leaking.length > 0) throw new Error(`secret-bearing final tarball: ${leaking.join(", ")}`);
    const contentLeaks = await secretBearingContentPaths(publicationDir, packedPaths);
    if (contentLeaks.length > 0) throw new Error(`secret-bearing final tarball content: ${contentLeaks.join(", ")}`);
    const surfaceViolations = carrierSurfaceViolations(manifest, packedPaths);
    if (surfaceViolations.length > 0) {
      const error = new Error(`final carrier has ${surfaceViolations.length} unresolved manifest surface declaration(s)`);
      error.evidence = { violations: surfaceViolations };
      throw error;
    }
    trace("pack-started");
    const packed = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], commandOptions);
    const artifact = join(root, packed.stdout.trim().split("\n").at(-1));
    await resolvePackedEntrypoints({ root, artifact, manifest });
    trace("verified");
    return Object.freeze({ publicationDir, artifact, cleanup: () => rm(root, { recursive: true, force: true }) });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
