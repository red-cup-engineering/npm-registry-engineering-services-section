import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, copyFile, writeFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { measureArtifactFile } from "@red-cup-engineering/npm-registry-services-section/npm-artifact-integrity-service";
import { verifyPackageRegistrySnapshot } from "@red-cup-engineering/npm-registry-snapshot-services-section/verify-package-registry-snapshot";

const PACKAGE_NAME = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function artifactNames(name, version) {
  const scoped = name.startsWith("@");
  const leaf = scoped ? name.slice(name.indexOf("/") + 1) : name;
  const prefix = scoped ? `${name.slice(1, name.indexOf("/"))}/${leaf}` : leaf;
  return `tarballs/${prefix}/-/${leaf}-${version}.tgz`;
}

function versionOrder(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function releaseSelector(value) {
  if (typeof value !== "string") throw new TypeError("excluded base release must be an exact package@version selector");
  const boundary = value.lastIndexOf("@");
  const name = value.slice(0, boundary), version = value.slice(boundary + 1);
  if (!PACKAGE_NAME.test(name) || !VERSION.test(version)) throw new TypeError("excluded base release must be an exact package@version selector");
  return { name, version };
}

async function suppliedRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("release must be an object");
  const manifest = value.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError("release manifest must be an object");
  if (!PACKAGE_NAME.test(manifest.name ?? "") || manifest.name.startsWith("@emsenn/")) throw new Error(`package identity is not sovereign: ${manifest.name ?? "unknown"}`);
  if (!VERSION.test(manifest.version ?? "")) throw new Error(`package version is not exact: ${manifest.name}`);
  if (typeof value.artifactPath !== "string" || !value.artifactPath) throw new TypeError("release artifactPath must be a non-empty string");
  const artifactPath = resolve(value.artifactPath);
  let status;
  try { status = await lstat(artifactPath); } catch (error) {
    if (error?.code === "ENOENT") throw new TypeError("release artifactPath must name an existing regular file");
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink()) throw new TypeError("release artifactPath must name an existing regular non-symbolic-link file");
  if (!SHA512_INTEGRITY.test(value.integrity ?? "")) throw new TypeError(`release integrity must be canonical sha512 SRI: ${manifest.name}@${manifest.version}`);
  return { manifest, artifactPath, integrity: value.integrity };
}

async function refuseSurvivingLocalDependencyProtocol(metadataDirectory) {
  const violations = [];
  let files;
  try { files = await readdir(metadataDirectory); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const metadata = JSON.parse(await readFile(join(metadataDirectory, file), "utf8"));
    for (const [version, manifest] of Object.entries(metadata.versions ?? {})) {
      for (const field of DEPENDENCY_FIELDS) for (const [dependency, constraint] of Object.entries(manifest?.[field] ?? {})) {
        if (typeof constraint === "string" && /^(?:workspace:|file:|link:)/u.test(constraint)) violations.push({ name: metadata.name, version, field, dependency, constraint });
      }
    }
  }
  if (violations.length) throw new Error(`registry build refused: local dependency protocol survives into published metadata: ${violations.map((v) => `${v.name}@${v.version} (${v.field}) ${v.dependency}@${v.constraint}`).join(", ")}`);
}

async function excludeBaseRelease(staging, entries, selector) {
  const removed = entries.filter(({ name, version }) => name === selector.name && version === selector.version);
  for (const entry of removed) await rm(join(staging, entry.artifact), { force: true });
  const metadataPath = join(staging, "metadata", `${encodeURIComponent(selector.name)}.json`);
  if (await exists(metadataPath)) {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    delete metadata.versions?.[selector.version];
    const remaining = Object.keys(metadata.versions ?? {}).sort(versionOrder);
    if (!remaining.length) await rm(metadataPath);
    else {
      metadata["dist-tags"] = { ...metadata["dist-tags"], latest: remaining.at(-1) };
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    }
  }
  return entries.filter(({ name, version }) => name !== selector.name || version !== selector.version);
}

/** Assemble caller-supplied release artifacts; no source discovery or packing occurs here. */
export async function assemblePackageRegistrySnapshot({ releases, outputDirectory, registryUrl, baseRegistryDirectory, excludedBaseReleases = [], compute } = {}) {
  if (!Array.isArray(releases)) throw new TypeError("releases must be an array");
  const base = new URL(registryUrl);
  if (!/^https?:$/u.test(base.protocol)) throw new TypeError("registryUrl must be absolute HTTP(S)");
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("registry artifact territory must be empty");
  const baseRegistry = baseRegistryDirectory === undefined ? null : resolve(baseRegistryDirectory);
  if (baseRegistry === output) throw new Error("base registry and output registry must be different territories");
  const prepared = (await Promise.all(releases.map(suppliedRelease))).sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  const collisions = Object.groupBy(prepared, ({ manifest }) => `${manifest.name}@${manifest.version}`);
  const duplicate = Object.keys(collisions).filter((identity) => collisions[identity].length > 1);
  if (duplicate.length) throw new Error(`duplicate package versions: ${duplicate.join(", ")}`);
  const baseReceipt = baseRegistry === null ? null : JSON.parse(await readFile(join(baseRegistry, "registry-receipt.json"), "utf8"));
  if (baseReceipt !== null && baseReceipt.registry !== base.href) throw new Error("base registry receipt URL must equal registryUrl for snapshot merge");
  const staging = await mkdtemp(join(output, ".assembling-"));
  let entries = baseReceipt === null ? [] : structuredClone(baseReceipt.packages ?? []);
  try {
    if (baseRegistry !== null) for (const entry of await readdir(baseRegistry)) await cp(join(baseRegistry, entry), join(staging, entry), { recursive: true, errorOnExist: true, force: false });
    for (const exclusion of excludedBaseReleases.map(releaseSelector)) entries = await excludeBaseRelease(staging, entries, exclusion);
    for (const { manifest, artifactPath, integrity } of prepared) {
      const artifact = artifactNames(manifest.name, manifest.version);
      const target = join(staging, artifact);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(artifactPath, target);
      const measured = await measureArtifactFile(target);
      if (measured.integrity !== integrity) throw new Error(`package release integrity differs from admitted claim: ${manifest.name}@${manifest.version}`);
      const tarball = new URL(artifact, base).href;
      const metadataPath = join(staging, "metadata", `${encodeURIComponent(manifest.name)}.json`);
      const prior = await exists(metadataPath) ? JSON.parse(await readFile(metadataPath, "utf8")) : null;
      if (prior?.versions?.[manifest.version] && prior.versions[manifest.version].dist?.integrity !== measured.integrity) throw new Error(`package release collision: ${manifest.name}@${manifest.version}`);
      const versionMetadata = { ...manifest, dist: { tarball, shasum: measured.shasum, integrity: measured.integrity } };
      const metadata = { _id: manifest.name, name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { ...(prior?.versions ?? {}), [manifest.version]: versionMetadata } };
      metadata["dist-tags"].latest = Object.keys(metadata.versions).sort(versionOrder).at(-1);
      await mkdir(dirname(metadataPath), { recursive: true });
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      entries = entries.filter((entry) => entry.name !== manifest.name || entry.version !== manifest.version);
      entries.push({ name: manifest.name, version: manifest.version, tarball, artifact, ...measured });
    }
    await refuseSurvivingLocalDependencyProtocol(join(staging, "metadata"));
    entries.sort((left, right) => left.name.localeCompare(right.name) || versionOrder(left.version, right.version));
    const scopes = [...new Set(entries.filter(({ name }) => name.startsWith("@")).map(({ name }) => name.slice(1, name.indexOf("/"))))].sort();
    await writeFile(join(staging, "client.npmrc"), [`registry=${base.href}`, ...scopes.map((scope) => `@${scope}:registry=${base.href}`), "audit=false", "fund=false", ""] .join("\n"));
    const receipt = { type: "SemioticVoxelPackageRegistryReceipt", version: 2, registry: base.href, packages: entries, packageCount: new Set(entries.map(({ name }) => name)).size, scopes, ...(compute === undefined ? {} : { compute }) };
    await writeFile(join(staging, "registry-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    await verifyPackageRegistrySnapshot({ registryDirectory: staging });
    for (const entry of await readdir(staging)) await rename(join(staging, entry), join(output, entry));
    await rm(staging, { recursive: true, force: true });
    return receipt;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
