import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { dependencyContractViolations } from "./dependency-policy.mjs";
import { sha256Digest } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

export const RECONCILE_NODE_VERSION = "v24.19.0";
export const RECONCILE_NPM_VERSION = "11.17.0";
const EXCLUDED = new Set(["node_modules", "package-lock.json", ".npmrc"]);


export async function packageSourceFingerprint(root) {
  const hash = createHash("sha256");
  async function visit(directory, prefix = "") {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || entry.name.startsWith(".package-lock.json.reconcile-")) continue;
      const absolute = join(directory, entry.name), path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = await lstat(absolute);
      if (stats.isDirectory()) await visit(absolute, path);
      else if (stats.isFile()) { const bytes = await readFile(absolute); hash.update(`file\0${path}\0${stats.mode & 0o777}\0${bytes.length}\0`); hash.update(bytes); }
      else if (stats.isSymbolicLink()) hash.update(`symlink\0${path}\0${await readlink(absolute)}\0`);
      else throw new Error(`${path}: unsupported package source input`);
    }
  }
  await visit(root);
  return `sha256:${hash.digest("hex")}`;
}

function declaredScopes(manifests) {
  const scopes = new Set();
  for (const manifest of manifests) for (const field of ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) if (name.startsWith("@")) scopes.add(name.slice(0, name.indexOf("/")));
  }
  return [...scopes].sort();
}

function npmArguments(registry, scopes) {
  return [`--registry=${registry}`, ...scopes.map((scope) => `--${scope}:registry=${registry}`), "--replace-registry-host=always", "--ignore-scripts", "--no-audit", "--no-fund"];
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ""}`)));
  });
}

async function mapConcurrent(items, concurrency, operation) {
  let cursor = 0, failure;
  async function worker() {
    while (!failure && cursor < items.length) {
      const index = cursor++;
      try { await operation(items[index], index); } catch (error) { failure ??= error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure) throw failure;
}

function registryViolations(packageLock, registry) {
  const violations = [];
  for (const [location, entry] of Object.entries(packageLock.packages ?? {})) {
    if (entry?.resolved !== undefined) {
      let artifact;
      try { artifact = new URL(entry.resolved); } catch { violations.push({ location, reason: "lock resolved address is not an absolute URL" }); continue; }
      const authority = new URL(registry);
      if (artifact.protocol !== authority.protocol || artifact.host !== authority.host || !artifact.pathname.startsWith(authority.pathname)) violations.push({ location, reason: "lock resolved address is outside admitted registry authority" });
    }
  }
  return violations;
}

function validateLock(manifest, packageLock, registry) {
  const violations = [];
  if (packageLock.lockfileVersion !== 3) violations.push({ reason: "package lock must use lockfileVersion 3" });
  violations.push(...dependencyContractViolations(manifest, packageLock), ...registryViolations(packageLock, registry));
  return violations;
}

function admittedInstallationRegistry(registry, canonicalRegistry) {
  const value = new URL(registry);
  if (value.username || value.password || value.search || value.hash) throw new Error("installation registry URL must not carry credentials, query, or fragment");
  if (value.protocol === "https:") return value;
  if (value.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(value.hostname) && new URL(canonicalRegistry).protocol === "https:") return value;
  throw new Error("installation registry must be HTTPS or an explicit loopback projection for an HTTPS canonical registry");
}

function canonicalizeResolvedRegistry(packageLock, installationRegistry, canonicalRegistry) {
  const installation = new URL(installationRegistry), canonical = new URL(canonicalRegistry);
  for (const [location, record] of Object.entries(packageLock.packages ?? {})) {
    if (record?.resolved === undefined) continue;
    const resolved = new URL(record.resolved);
    if (resolved.origin !== installation.origin || !resolved.pathname.startsWith(installation.pathname)) {
      throw new Error(`${location}: generated resolved address is outside the admitted installation registry`);
    }
    const tail = location.replace(/^node_modules\//u, "").split("/node_modules/").at(-1);
    const parts = tail.split("/");
    const name = record.name ?? (parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
    if (!name || typeof record.version !== "string") throw new Error(`${location}: generated registry node has no canonical package identity`);
    const tarball = name.slice(name.lastIndexOf("/") + 1);
    record.resolved = new URL(`${name}/-/${tarball}-${record.version}.tgz`, canonical).href;
  }
  return packageLock;
}

async function resolveRoots(workspaceRoot, roots) {
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError("roots must be a non-empty explicit package-root array");
  const workspace = await realpath(workspaceRoot);
  const records = [];
  for (const claim of roots) {
    if (claim === null || typeof claim !== "object" || typeof claim.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(claim.id) || typeof claim.path !== "string") throw new TypeError("each package root requires a filesystem-safe id and path");
    const source = await realpath(resolve(workspace, claim.path));
    const relativePath = relative(workspace, source);
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) throw new Error(`package root ${claim.id} is outside the workspace or names the workspace itself`);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    records.push({ id: claim.id, source, relativePath, manifest });
  }
  if (new Set(records.map(({ id }) => id)).size !== records.length) throw new Error("package root ids must be unique");
  return { workspace, records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

export async function reconcilePackageLocks({
  workspaceRoot,
  roots,
  registry,
  installationRegistry = registry,
  token,
  npmCommand = "npm",
  expectedNodeVersion = RECONCILE_NODE_VERSION,
  expectedNpmVersion = RECONCILE_NPM_VERSION,
  concurrency = 4,
  temporaryBase = "/tmp",
  commandRunner = run,
  beforeWrite = async () => {},
} = {}) {
  if (process.version !== expectedNodeVersion) throw new Error(`Node ${expectedNodeVersion} is required; found ${process.version}`);
  if (typeof registry !== "string" || !/^https:\/\//u.test(registry)) throw new TypeError("registry must be an HTTPS URL");
  if (token !== undefined && (typeof token !== "string" || token === "")) throw new TypeError("registry token must be a non-empty string when supplied");
  const npmVersion = (await commandRunner(npmCommand, ["--version"], { capture: true })).stdout.trim();
  if (npmVersion !== expectedNpmVersion) throw new Error(`npm ${expectedNpmVersion} is required; found ${npmVersion}`);
  const { workspace, records } = await resolveRoots(workspaceRoot, roots);
  const fingerprints = new Map(await Promise.all(records.map(async (record) => [record.id, await packageSourceFingerprint(record.source)])));
  const temporaryRoot = await mkdtemp(join(temporaryBase, "npm-lock-reconcile-"));
  const npmrc = join(temporaryRoot, "npmrc"), globalNpmrc = join(temporaryRoot, "global-npmrc");
  const authority = new URL(registry), installationAuthority = admittedInstallationRegistry(installationRegistry, authority.href);
  const authentication = token === undefined ? "" : `//${installationAuthority.host}${installationAuthority.pathname}:_authToken=${token}\n`;
  await writeFile(npmrc, `registry=${installationAuthority.href}\n${authentication}`, { mode: 0o600 });
  await writeFile(globalNpmrc, "", { mode: 0o600 });
  const environment = { ...process.env, ...(token === undefined ? {} : { NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: globalNpmrc }), NPM_CONFIG_CACHE: join(temporaryRoot, "cache"), NPM_CONFIG_REGISTRY: installationAuthority.href, TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" };
  const args = npmArguments(installationAuthority.href, declaredScopes(records.map(({ manifest }) => manifest)));
  try {
    for (const record of records) await cp(record.source, join(temporaryRoot, "workspace", record.relativePath), { recursive: true, filter: (path) => !EXCLUDED.has(basename(path)) });
    const results = [];
    await mapConcurrent(records, concurrency, async (record) => {
      const stage = join(temporaryRoot, "workspace", record.relativePath), lockPath = join(stage, "package-lock.json");
      try {
        await commandRunner(npmCommand, ["install", "--package-lock-only", ...args], { cwd: stage, env: environment });
      } catch (error) {
        throw new Error(`${record.id}: package-lock generation refused: ${error.message}`, { cause: error });
      }
      const generatedLock = JSON.parse(await readFile(lockPath, "utf8"));
      const violations = validateLock(record.manifest, generatedLock, installationAuthority.href);
      if (violations.length) throw new Error(`${record.id}: generated package lock violates policy: ${JSON.stringify(violations)}`);
      results.push({ ...record, stage, generatedLock, target: join(record.source, "package-lock.json") });
    });
    await mapConcurrent(results, concurrency, ({ stage }) => commandRunner(npmCommand, ["ci", ...args], { cwd: stage, env: environment }));
    await mapConcurrent(results, concurrency, ({ stage, manifest }) => Object.hasOwn(manifest.scripts ?? {}, "verify") ? commandRunner(npmCommand, ["run", "verify"], { cwd: stage, env: environment }) : Promise.resolve());
    for (const result of results) {
      const canonicalLock = canonicalizeResolvedRegistry(structuredClone(result.generatedLock), installationAuthority.href, authority.href);
      const violations = validateLock(result.manifest, canonicalLock, authority.href);
      if (violations.length) throw new Error(`${result.id}: canonical package lock violates policy: ${JSON.stringify(violations)}`);
      result.bytes = Buffer.from(`${JSON.stringify(canonicalLock, null, 2)}\n`);
      result.digest = sha256Digest(result.bytes);
    }
    const drifted = (await Promise.all(records.map(async (record) => ({ id: record.id, expected: fingerprints.get(record.id), observed: await packageSourceFingerprint(record.source) })))).filter(({ expected, observed }) => expected !== observed);
    if (drifted.length) throw new Error(`package source inputs changed before lock write: ${JSON.stringify(drifted)}`);
    await beforeWrite({ results });
    const writes = [];
    try {
      for (const result of results) {
        const temporary = join(dirname(result.target), `.package-lock.json.reconcile-${randomUUID()}.tmp`);
        await writeFile(temporary, result.bytes, { flag: "wx" });
        writes.push({ temporary, target: result.target });
      }
      for (const write of writes) await rename(write.temporary, write.target);
    } finally {
      await Promise.all(writes.map(({ temporary }) => rm(temporary, { force: true })));
    }
    return Object.freeze({ type: "NpmPackageLockReconciliationReceipt", version: 1, registry: authority.href, installationRegistry: installationAuthority.href, nodeVersion: process.version, npmVersion, locks: results.sort((a, b) => a.id.localeCompare(b.id)).map(({ id, relativePath: path, digest }) => ({ id, path, digest })) });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
