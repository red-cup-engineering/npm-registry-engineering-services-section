import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { packageNameFromLockLocation } from "./lockfile-registry-classification.mjs";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

/** Cache one exact upstream release for a registry with automatic proxying disabled.
 * Run offline. Existing releases cannot be overwritten; metadata has a backup and
 * compare-before-write check. No registry routing or publication tags are changed.
 * @param {import('./verdaccio-upstream-cache.mjs').UpstreamCacheInput} input
 */
export async function cacheVerdaccioUpstreamRelease({ storage, packageName, version, upstream = "https://registry.npmjs.org/", backupDirectory, apply = false, fetcher = fetch, expectedIntegrity }) {
  if (typeof packageName !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new TypeError("invalid package name");
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError("an exact version is required");
  const authority = new URL(upstream);
  if (authority.protocol !== "https:" || authority.username || authority.password || authority.search || authority.hash) throw new TypeError("upstream must be an HTTPS registry without credentials");
  const response = await fetcher(new URL(`${encodeURIComponent(packageName)}/${version}`, authority.href.endsWith("/") ? authority : authority.href + "/"));
  if (!response.ok) throw new Error(`upstream metadata returned ${response.status}`);
  const manifest = await response.json();
  if (manifest.name !== packageName || manifest.version !== version) throw new Error("upstream package identity mismatch");
  const integrity = manifest.dist?.integrity;
  if (expectedIntegrity !== undefined && expectedIntegrity !== integrity) throw new Error("upstream integrity differs from the consumer lock");
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error("upstream must declare SHA-512 integrity");
  const tarballURL = new URL(manifest.dist.tarball);
  if (tarballURL.origin !== authority.origin) throw new Error("tarball must belong to the explicit upstream authority");
  const archiveResponse = await fetcher(tarballURL);
  if (!archiveResponse.ok) throw new Error(`upstream archive returned ${archiveResponse.status}`);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== integrity) throw new Error("upstream archive integrity mismatch");
  const directory = join(resolve(storage), packageName), path = join(directory, "package.json");
  let original, packument;
  try { original = await readFile(path); packument = JSON.parse(original); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    original = Buffer.from(JSON.stringify({ name: packageName, versions: {}, "dist-tags": {}, _distfiles: {} }) + "\n");
    packument = JSON.parse(original);
  }
  if (packument.name !== packageName) throw new Error("stored package identity mismatch");
  const existing = packument.versions?.[version];
  if (existing && existing.dist?.integrity !== integrity) throw new Error("refusing to overwrite a different existing release");
  const filename = `${packageName.split("/").at(-1)}-${version}.tgz`;
  let cached;
  try { cached = await readFile(join(directory, filename)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (cached && !cached.equals(archive)) throw new Error("refusing to overwrite different cached archive bytes");
  const changed = !existing || !cached;
  const digest = sha256Hex(original);
  if (apply && changed) {
    if (!backupDirectory) throw new TypeError("backupDirectory is required when applying");
    await mkdir(resolve(backupDirectory), { recursive: true });
    if (!(await readFile(path).catch((error) => error.code === "ENOENT" ? original : Promise.reject(error))).equals(original)) throw new Error("registry metadata changed since observation");
    await writeFile(join(resolve(backupDirectory), digest + ".json"), original, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    await mkdir(directory, { recursive: true });
    if (!cached) await writeFile(join(directory, filename), archive, { flag: "wx" });
    const updated = { ...packument, versions: { ...packument.versions, [version]: manifest }, _distfiles: { ...packument._distfiles, [filename]: { url: tarballURL.href, sha: createHash("sha1").update(archive).digest("hex"), registry: "npmjs" } } };
    await writeFileText(path, JSON.stringify(updated, null, 2) + "\n");
  }
  return { packageName, version, integrity, byteCount: archive.length, changed, applied: apply && changed, priorDigest: digest };
}

/** Observe only explicit upstream resolutions in an npm lock; local house pins
 * never become upstream lookups. Materialize missing exact archives in one run. */
export async function cacheVerdaccioLockfile({ storage, packageLock, upstream = "https://registry.npmjs.org/", backupDirectory, apply = false, fetcher = fetch }) {
 const origin = new URL(upstream).origin, claims = new Map();
 for (const [location, entry] of Object.entries(packageLock.packages ?? {})) {
  if (!location || !entry.resolved || new URL(entry.resolved).origin !== origin) continue;
  const packageName = entry.name ?? packageNameFromLockLocation(location);
  const id = `${packageName}@${entry.version}`;
  if (claims.has(id) && claims.get(id).expectedIntegrity !== entry.integrity) throw new Error(`conflicting lock integrity: ${id}`);
  claims.set(id, { packageName, version: entry.version, expectedIntegrity: entry.integrity });
 }
 const missing = [];
 for (const claim of claims.values()) {
  const directory = join(resolve(storage), claim.packageName);
  let metadata, archive;
  try { metadata = JSON.parse(await readFile(join(directory,"package.json"))); archive = await readFile(join(directory,`${claim.packageName.split('/').at(-1)}-${claim.version}.tgz`)); }
  catch(error) { if(error.code !== 'ENOENT') throw error; }
  if (!metadata?.versions?.[claim.version] || !archive || `sha512-${createHash('sha512').update(archive).digest('base64')}` !== claim.expectedIntegrity) missing.push(claim);
 }
 const results = [];
 if (apply) for (const claim of missing) results.push(await cacheVerdaccioUpstreamRelease({storage,...claim,upstream,backupDirectory,apply,fetcher}));
 return { checked: claims.size, missing, results, applied: apply };
}
