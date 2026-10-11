import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, link, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { effectivePackageDependencyEdges, isExactSemver, publicationManifest, resolvePackageLockDependency } from "./dependency-policy.mjs";
import { downloadConfiguredNpmRegistryTarball, readConfiguredNpmRegistryPackageVersion } from "./registry.mjs";
import { scanWorkspaceManifests } from "./read-workspace-manifests.mjs";
import { verifyIsolatedCarrier } from "./isolated-carrier-verification.mjs";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const TOOLCHAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const execFile = promisify(execFileCallback);

// semver stays an external dependency, but only the registry-resolution branch below
// (lock selections admitted against a requested range) ever needs it — the eager
// top-level import made every consumer of this package's root barrel load semver
// whether or not it ever resolves a registry provider. Loaded lazily, as
// pin-exact-dependencies.mjs already does.
async function semverSatisfies(version, range) {
  const { default: semver } = await import("semver");
  return semver.satisfies(version, range);
}

function runtimeDependencies(manifest, { includeDevelopment = false } = {}) {
  return effectivePackageDependencyEdges(manifest, { root: includeDevelopment })
    .map(({ name, specification: version, optional }) => ({ name, version, optional }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function entryClaims(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("entries must be a non-empty array");
  const claims = entries.map((entry) => typeof entry === "string" ? { id: entry, name: entry } : entry);
  for (const claim of claims) {
    if (claim === null || typeof claim !== "object" || typeof claim.name !== "string" || !claim.name) throw new TypeError("each entry requires a package name");
    if (typeof claim.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(claim.id)) throw new TypeError(`entry ${claim.name} requires a filesystem-safe id`);
  }
  if (new Set(claims.map(({ id }) => id)).size !== claims.length) throw new Error("entry ids must be unique");
  return claims.sort((left, right) => left.id.localeCompare(right.id));
}

function localLifecycleProviders(entryRecords, byName) {
  const selected = new Map();
  const pending = entryRecords.map(({ name, version }) => ({ name, version }));
  while (pending.length > 0) {
    const identity = pending.shift();
    const key = `${identity.name}\0${identity.version}`;
    if (selected.has(key)) continue;
    const matches = (byName.get(identity.name) ?? []).filter(({ version }) => version === identity.version);
    if (matches.length !== 1) throw new Error(`local lifecycle provider ${identity.name}@${identity.version} is ${matches.length === 0 ? "absent" : "duplicated"}`);
    const provider = matches[0];
    selected.set(key, provider);
    for (const field of ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]) {
      for (const [name, version] of Object.entries(provider.manifest[field] ?? {})) {
        if (isExactSemver(version) && (byName.get(name) ?? []).some((candidate) => candidate.version === version)) pending.push({ name, version });
      }
    }
  }
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function exactLifecycleToolchainRequirements(providers) {
  const requirements = new Map();
  for (const provider of providers) {
    for (const [name, version] of Object.entries(provider.manifest.engines ?? {})) {
      if (!isExactSemver(version)) continue;
      if (!TOOLCHAIN_NAME.test(name)) throw new Error(`lifecycle provider ${provider.name}@${provider.version} declares an invalid engine name ${name}`);
      const previous = requirements.get(name);
      if (previous !== undefined && previous.version !== version) {
        throw new Error(`lifecycle toolchain ${name} has conflicting exact requirements ${previous.version} from ${previous.provider} and ${version} from ${provider.name}@${provider.version}`);
      }
      requirements.set(name, { version, provider: `${provider.name}@${provider.version}` });
    }
  }
  return requirements;
}

async function observeLifecycleToolchain(name) {
  if (name === "node") return process.versions.node;
  const { stdout, stderr } = await execFile(name, ["--version"], { timeout: 10_000, windowsHide: true });
  const observed = `${stdout}${stderr}`.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/u)?.[0];
  if (observed === undefined) throw new Error(`lifecycle toolchain ${name} did not report an exact semantic version`);
  return observed;
}

async function admitLifecycleToolchains(providers, observer) {
  const requirements = exactLifecycleToolchainRequirements(providers);
  const admitted = {};
  for (const [name, requirement] of [...requirements].sort(([left], [right]) => left.localeCompare(right))) {
    let observed;
    try { observed = await observer(name); }
    catch (error) { throw new Error(`required lifecycle toolchain ${name}@${requirement.version} is unavailable: ${error.message}`); }
    if (observed !== requirement.version) throw new Error(`required lifecycle toolchain ${name}@${requirement.version} differs from observed ${observed}`);
    admitted[name] = Object.freeze({ version: requirement.version, observed, requiredBy: requirement.provider });
  }
  return Object.freeze(admitted);
}

function registryArtifactAuthority(registry, tarball) {
  const authority = new URL(registry.endsWith("/") ? registry : `${registry}/`);
  const artifact = new URL(tarball);
  if (artifact.protocol !== authority.protocol || artifact.host !== authority.host || !artifact.pathname.startsWith(authority.pathname)) {
    throw new Error(`registry artifact ${artifact.href} is outside admitted registry authority ${authority.href}`);
  }
  return artifact;
}

async function readSourcePackageLock(source, { requireRootIdentity = true } = {}) {
  const path = join(source.sourceDirectory ?? source.dir, "package-lock.json");
  let packageLock;
  try { packageLock = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { packageLock: null, path };
    throw new Error(`runtime source ${source.name}@${source.version} package lock is unreadable: ${error.message}`);
  }
  if (packageLock?.lockfileVersion !== 3 || packageLock.packages === null || typeof packageLock.packages !== "object") {
    throw new Error(`runtime source ${source.name}@${source.version} requires a package-lock v3 resolution authority`);
  }
  const root = packageLock.packages[""];
  if (requireRootIdentity && (root?.name !== source.name || root?.version !== source.version)) {
    throw new Error(`runtime source package lock root does not identify ${source.name}@${source.version}`);
  }
  return { packageLock, path };
}

function lockLocationForIdentity(packageLock, name, version) {
  const suffix = `/node_modules/${name}`;
  const matches = Object.entries(packageLock.packages).filter(([location, record]) =>
    (location === `node_modules/${name}` || location.endsWith(suffix)) && record?.link !== true && record?.version === version);
  if (matches.length !== 1) throw new Error(`entry package lock must contain one unambiguous location for external provider ${name}@${version}; found ${matches.length}`);
  return matches[0][0];
}

async function admitLockSelection({ entry, lockAuthority, requiringLocation, dependency }) {
  const resolved = resolvePackageLockDependency(lockAuthority.packageLock, requiringLocation, dependency.name);
  if (resolved.entry === null) {
    if (dependency.optional && resolved.selectedLocation === null) return null;
    throw new Error(`runtime entry ${entry.id} lock has no selection for ${dependency.name} requested by ${requiringLocation || "<root>"}: ${resolved.reason ?? "dependency edge has no Node-resolvable lock entry"}`);
  }
  const version = resolved.entry?.version;
  if (!isExactSemver(version ?? "")) {
    throw new Error(`runtime entry ${entry.id} lock selection ${resolved.location} has no exact version for ${dependency.name}`);
  }
  if (!(await semverSatisfies(version, dependency.version))) {
    throw new Error(`runtime entry ${entry.id} lock selection ${dependency.name}@${version} does not satisfy ${dependency.version} requested by ${requiringLocation || "<root>"}`);
  }
  if (resolved.selectedEntry?.link === true) throw new Error(`runtime entry ${entry.id} lock selection ${resolved.selectedLocation} is a mutable link`);
  return { location: resolved.location, record: resolved.entry, version };
}

async function downloadVerifiedTarball({ registry, name, version, integrity, tarball, destination, fetcher }) {
  const artifact = registryArtifactAuthority(registry, tarball);
  const headers = process.env.NODE_AUTH_TOKEN ? { authorization: `Bearer ${process.env.NODE_AUTH_TOKEN}` } : {};
  // Artifact Registry answers an admitted tarball URL with a short-lived download
  // redirect. Native fetch strips Authorization on a cross-origin redirect; the
  // registry's integrity claim remains the authority for the received bytes.
  const response = await fetcher(artifact, { headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`registry artifact ${name}@${version} returned HTTP ${response.status}`);
  if (response.body === null) throw new Error(`registry artifact ${name}@${version} has no response body`);
  await mkdir(resolve(destination, ".."), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash("sha512");
  let size = 0;
  let streamFailure = null;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > 512 * 1024 * 1024) throw new Error(`registry artifact ${name}@${version} exceeds 512 MiB`);
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } catch (error) {
    streamFailure = error;
  } finally {
    await handle.close();
  }
  if (streamFailure !== null) {
    await rm(temporary, { force: true });
    throw streamFailure;
  }
  const observed = `sha512-${hash.digest("base64")}`;
  if (observed !== integrity) {
    await rm(temporary, { force: true });
    throw new Error(`registry artifact ${name}@${version} integrity mismatch`);
  }
  try { await link(temporary, destination); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(destination);
    if (`sha512-${createHash("sha512").update(existing).digest("base64")}` !== integrity) throw new Error(`existing registry artifact ${name}@${version} has conflicting bytes`);
  } finally {
    await rm(temporary, { force: true });
  }
}

function artifactFilename(name, version, integrity) {
  const digest = sha256Hex(integrity).slice(0, 16);
  return `${name.replaceAll("@", "").replaceAll("/", "-")}-${version}-${digest}.tgz`;
}

async function retainLocalCarrier({ provider, registry, dependencyArtifacts, output, npmEnvironment, localCarrierVerifier }) {
  const verified = await localCarrierVerifier({ sourceDir: provider.dir, manifest: provider.manifest, registry, dependencyArtifacts, npmEnvironment });
  try {
    const bytes = await readFile(verified.artifact);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const tarballPath = join(output, "tarballs", artifactFilename(provider.name, provider.version, integrity));
    await mkdir(resolve(tarballPath, ".."), { recursive: true });
    try { await copyFile(verified.artifact, tarballPath, 1); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    return { name: provider.name, version: provider.version, integrity, tarballPath };
  } finally { await verified.cleanup(); }
}

export async function formNodeRuntimeProviderCatalog({
  workspaceRoot,
  entries,
  registry,
  outputDirectory,
  registryVersionReader = readConfiguredNpmRegistryPackageVersion,
  fetcher = fetch,
  tarballDownloader,
  sourcePackageLockReader = readSourcePackageLock,
  entryPackageLockReader = null,
  localCarrierVerifier = verifyIsolatedCarrier,
  lifecycleToolchainObserver = observeLifecycleToolchain,
  entryDependencyScope = "runtime",
  sourceIdentityAuthority = "lock",
  entryProvider = "source",
}) {
  if (typeof registry !== "string" || !/^https?:\/\//u.test(registry)) throw new TypeError("registry must be an absolute HTTP(S) URL");
  const registryUrl = new URL(registry);
  if (registryUrl.username || registryUrl.password || registryUrl.search || registryUrl.hash) throw new Error("registry URL must not carry credentials, query, or fragment");
  const registryAuthority = registryUrl.href.endsWith("/") ? registryUrl.href : `${registryUrl.href}/`;
  if (!["runtime", "install"].includes(entryDependencyScope)) throw new TypeError("entryDependencyScope must be runtime or install");
  if (!["lock", "manifest"].includes(sourceIdentityAuthority)) throw new TypeError("sourceIdentityAuthority must be lock or manifest");
  if (!["source", "registry"].includes(entryProvider)) throw new TypeError("entryProvider must be source or registry");
  const root = await realpath(workspaceRoot);
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  // npm owns configured credential resolution; this admission passes the
  // registry explicitly but never shadows the operator's protected config.
  const npmEnvironment = { NPM_CONFIG_REGISTRY: registryAuthority, NPM_CONFIG_CACHE: join(output, ".npm-cache"), TMPDIR: "/tmp", TEMP: "/tmp", TMP: "/tmp" };
  const sources = (await scanWorkspaceManifests(root))
    .filter(({ manifest }) => typeof manifest?.name === "string" && manifest.name && typeof manifest.version === "string");
  // A runtime carrier is built from packages as they are published: each local manifest is read with
  // its workspace:* siblings at their exact versions (dependency-policy publicationManifest).
  const siblingVersion = (name) => { const sites = sources.filter(({ manifest }) => manifest.name === name); return sites.length === 1 ? sites[0].manifest.version : undefined; };
  const packages = sources.map(({ dir, manifest }) => ({ name: manifest.name, version: manifest.version, dir, manifest: publicationManifest(manifest, siblingVersion) }));
  const byName = new Map();
  for (const item of packages) {
    if (!byName.has(item.name)) byName.set(item.name, []);
    byName.get(item.name).push(item);
  }
  const declaredEntries = entryClaims(entries);
  const entryRecords = declaredEntries.map((claim) => {
    const matches = byName.get(claim.name) ?? [];
    if (matches.length === 0) throw new Error(`runtime entry workspace package is absent: ${claim.name}`);
    if (matches.length > 1) throw new Error(`runtime entry workspace package is duplicated: ${claim.name}`);
    return { id: claim.id, name: claim.name, version: matches[0].version, sourceDirectory: matches[0].dir };
  });
  // Registry carriers are immutable published artifacts, so their admission
  // does not run a local lifecycle.
  const lifecycleToolchains = entryProvider === "source"
    ? await admitLifecycleToolchains(localLifecycleProviders(entryRecords, byName), lifecycleToolchainObserver)
    : Object.freeze({});
  const registryProviders = new Map();
  const retainedLocalClaims = new Map();
  const lockReader = entryPackageLockReader ?? ((source) => sourcePackageLockReader(source, { requireRootIdentity: sourceIdentityAuthority === "lock" }));
  const sourceLocks = new Map();
  async function sourceLock(source) {
    if (!sourceLocks.has(source.dir ?? source.sourceDirectory)) sourceLocks.set(source.dir ?? source.sourceDirectory, await lockReader(source));
    return sourceLocks.get(source.dir ?? source.sourceDirectory);
  }
  const admissions = {};
  for (const entry of entryRecords) {
    const entrySource = (byName.get(entry.name) ?? []).find(({ version }) => version === entry.version);
    const lockAuthority = await sourceLock(entrySource);
    const localProviders = new Map();
    const externalClaims = new Map();
    async function registryProvider(name, version, lockRecord = null) {
      const identity = `${name}@${version}`;
      const lockedIntegrity = lockRecord?.integrity, lockedResolved = lockRecord?.resolved;
      if (lockRecord !== null) {
        if (!SHA512_INTEGRITY.test(lockedIntegrity ?? "") || typeof lockedResolved !== "string") throw new Error(`runtime entry ${entry.id} lock selection for ${identity} lacks immutable registry evidence`);
        registryArtifactAuthority(registryAuthority, lockedResolved);
      }
      let provider = registryProviders.get(identity);
      if (provider !== undefined) {
        if (lockRecord !== null && provider.claim.integrity !== lockedIntegrity) throw new Error(`registry provider ${identity} differs from its lock integrity evidence`);
        return provider;
      }
      const observation = await registryVersionReader(registryAuthority, name, version, { npmEnvironment });
      if (!observation.reachable) throw new Error(`registry is unreachable while resolving ${identity}`);
      if (observation.authorizationFailed) throw new Error(`registry authentication failed while resolving ${identity}`);
      if (!observation.found) throw new Error(`registry has no exact runtime provider ${identity}`);
      const manifest = observation.manifest, integrity = manifest?.dist?.integrity, tarball = manifest?.dist?.tarball;
      if (manifest?.name !== name || manifest?.version !== version) throw new Error(`registry exact-version response does not identify ${identity}`);
      if (!SHA512_INTEGRITY.test(integrity ?? "") || typeof tarball !== "string") throw new Error(`registry provider ${identity} lacks immutable artifact evidence`);
      if (lockRecord !== null && integrity !== lockedIntegrity) throw new Error(`registry provider ${identity} differs from its lock integrity evidence`);
      registryArtifactAuthority(registryAuthority, tarball);
      const tarballPath = join(output, "tarballs", artifactFilename(name, version, integrity));
      if (tarballDownloader !== undefined) {
        await tarballDownloader({ registry: registryAuthority, name, version, integrity, tarball, destination: tarballPath, npmEnvironment });
      } else if (fetcher === fetch) {
        await downloadConfiguredNpmRegistryTarball({ registry: registryAuthority, name, version, integrity, destination: tarballPath, npmEnvironment });
      } else {
        await downloadVerifiedTarball({ registry: registryAuthority, name, version, integrity, tarball, destination: tarballPath, fetcher });
      }
      provider = { manifest, claim: { name, version, integrity, tarballPath } };
      registryProviders.set(identity, provider);
      return provider;
    }
    let rootNode;
    if (entryProvider === "source") {
      localProviders.set(`${entrySource.name}\0${entrySource.version}`, entrySource);
      rootNode = { location: "", name: entry.name, version: entry.version, authorityKind: "local-source-carrier", manifest: entrySource.manifest, provider: entrySource, edges: {} };
    } else {
      const admitted = await registryProvider(entry.name, entry.version);
      rootNode = { location: "", name: entry.name, version: entry.version, authorityKind: "registry-exact-carrier", manifest: admitted.manifest, provider: null, claim: admitted.claim, edges: {} };
    }
    const nodes = new Map([["", rootNode]]);
    const pending = [""];
    while (pending.length > 0) {
      const ownerLocation = pending.shift(), owner = nodes.get(ownerLocation);
      for (const dependency of runtimeDependencies(owner.manifest, { includeDevelopment: entryDependencyScope === "install" && ownerLocation === "" })) {
        if (!PACKAGE_NAME.test(dependency.name)) throw new Error(`runtime dependency has invalid package identity: ${dependency.name}`);
        const resolved = lockAuthority.packageLock === null ? { selectedLocation: null, selectedEntry: null, location: null, entry: null, reason: "source has no package lock" } : resolvePackageLockDependency(lockAuthority.packageLock, ownerLocation, dependency.name);
        let location, name = dependency.name, version, manifest, authorityKind, provider, claim = null;
        if (entryProvider === "registry") {
          const selection = await admitLockSelection({ entry, lockAuthority, requiringLocation: ownerLocation, dependency });
          if (selection === null) continue;
          const admitted = await registryProvider(dependency.name, selection.version, selection.record);
          location = selection.location; version = selection.version; manifest = admitted.manifest; authorityKind = "registry-lock-carrier"; claim = admitted.claim;
          externalClaims.set(`${name}\0${version}`, claim);
        } else {
          const local = isExactSemver(dependency.version) ? (byName.get(dependency.name) ?? []).filter(({ version }) => version === dependency.version) : [];
          if (local.length > 1) throw new Error(`workspace provider identity is duplicated: ${dependency.name}@${dependency.version}`);
          if (local.length === 1) {
            location = resolved.selectedEntry?.version === dependency.version ? resolved.selectedLocation : null;
            location ??= ownerLocation === "" ? `node_modules/${name}` : `${ownerLocation}/node_modules/${name}`;
            version = dependency.version; provider = local[0]; manifest = provider.manifest; authorityKind = "local-source-carrier";
            localProviders.set(`${name}\0${version}`, provider);
          } else {
            if (isExactSemver(dependency.version)) {
              version = dependency.version;
              location = resolved.entry?.version === version ? resolved.location : null;
              location ??= ownerLocation === "" ? `node_modules/${name}` : `${ownerLocation}/node_modules/${name}`;
              const admitted = await registryProvider(name, version);
              manifest = admitted.manifest; claim = admitted.claim; authorityKind = "registry-exact-carrier";
              externalClaims.set(`${name}\0${version}`, claim);
            } else if (resolved.entry === null) {
              if (dependency.optional && resolved.selectedLocation === null) continue;
              throw new Error(`runtime entry ${entry.id} lock has no placement for ${dependency.name} requested by ${ownerLocation || "<root>"}`);
            } else {
              location = resolved.location; version = resolved.entry.version;
              if (!isExactSemver(version ?? "") || !(await semverSatisfies(version, dependency.version))) throw new Error(`runtime entry ${entry.id} lock selection ${name}@${version ?? "<absent>"} does not satisfy ${dependency.version} at ${ownerLocation || "<root>"}`);
              const admitted = await registryProvider(name, version, resolved.entry);
              manifest = admitted.manifest; claim = admitted.claim; authorityKind = "registry-lock-carrier";
              externalClaims.set(`${name}\0${version}`, claim);
            }
          }
        }
        const existing = nodes.get(location);
        if (existing && (existing.name !== name || existing.version !== version)) throw new Error(`runtime entry ${entry.id} location ${location} conflicts: ${existing.name}@${existing.version} versus ${name}@${version}`);
        owner.edges[name] = location;
        if (!existing) { nodes.set(location, { location, name, version, authorityKind, manifest, provider, claim, edges: {} }); pending.push(location); }
      }
    }
    const localClaims = retainedLocalClaims, packing = new Set();
    async function packLocal(provider) {
      const identity = `${provider.name}\0${provider.version}`;
      if (localClaims.has(identity)) return localClaims.get(identity);
      if (packing.has(identity)) throw new Error(`local carrier lifecycle dependency cycle includes ${provider.name}@${provider.version}`);
      packing.add(identity);
      for (const field of ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]) {
        for (const [name, version] of Object.entries(provider.manifest[field] ?? {})) {
          if (!isExactSemver(version)) continue;
          const match = (byName.get(name) ?? []).find((candidate) => candidate.version === version);
          if (match) await packLocal(match);
        }
      }
      const dependencyArtifacts = new Map([...externalClaims.values(), ...localClaims.values()].map((claim) => [`${claim.name}\0${claim.version}`, claim.tarballPath]));
      const claim = await retainLocalCarrier({ provider, registry: registryAuthority, dependencyArtifacts, output, npmEnvironment, localCarrierVerifier });
      localClaims.set(identity, claim);
      packing.delete(identity);
      return claim;
    }
    if (entryProvider === "source") {
      for (const provider of [...localProviders.values()].sort((a, b) => a.name.localeCompare(b.name))) await packLocal(provider);
    }
    const admittedNodes = {};
    for (const [location, node] of [...nodes].sort(([a], [b]) => a.localeCompare(b))) {
      const claim = node.authorityKind === "local-source-carrier" ? localClaims.get(`${node.name}\0${node.version}`) : node.claim;
      if (!claim) throw new Error(`tarball admission is absent for ${node.name}@${node.version} at ${location || "<root>"}`);
      admittedNodes[location] = { location, name: node.name, version: node.version, authorityKind: node.authorityKind, integrity: claim.integrity, tarballPath: claim.tarballPath, edges: Object.fromEntries(Object.entries(node.edges).sort(([a], [b]) => a.localeCompare(b))) };
    }
    admissions[entry.id] = {
      nodes: admittedNodes,
    };
  }
  const catalog = {
    type: "NodeRuntimeProviderCatalog",
    version: 1,
    registry: registryAuthority,
    entries: entryRecords.map(({ sourceDirectory: _sourceDirectory, ...claim }) => claim).sort((left, right) => left.id.localeCompare(right.id)),
    admissions,
    lifecycleToolchains,
    entryDependencyScope,
    sourceIdentityAuthority,
    entryProvider,
  };
  await rm(join(output, ".npm-cache"), { recursive: true, force: true });
  const catalogPath = join(output, "node-runtime-provider-catalog.json");
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return Object.freeze({ ...catalog, catalogPath });
}

export function materializerInputsFromProviderCatalog(catalog) {
  if (catalog?.type !== "NodeRuntimeProviderCatalog" || catalog.version !== 1) throw new TypeError("catalog must be a NodeRuntimeProviderCatalog v1");
  return Object.freeze({
    entries: Object.freeze(catalog.entries.map(({ id }) => Object.freeze({ id, nodes: Object.freeze(structuredClone(catalog.admissions[id].nodes)) }))),
  });
}
