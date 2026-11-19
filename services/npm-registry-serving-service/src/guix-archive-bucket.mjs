import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";

const archiveKey = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/-\/[^/\\\x00-\x1f]+\.tgz$/iu;
const allocationName = /^archive-[a-z0-9]+$/iu;
const digest = (algorithm, value, encoding) => createHash(algorithm).update(value).digest(encoding);
const existsError = (error, code) => error && error.code === code;

export function isPackageArchiveKey(key) {
  return typeof key === "string" && archiveKey.test(key);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileIntegrity(path) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return "sha512-" + hash.digest("base64");
}

/**
 * The existing registry owns packuments and publication claims through
 * metadataBucket. This binding stores only package archives, rooted by
 * Guix, and publishes a key through an atomic create-if-absent receipt.
 */
export async function createGuixArchiveBucket({
  metadataBucket, root, register, storeDirectory = "/gnu/store", collectorDirectory,
}) {
  if (!isAbsolute(root) || !isAbsolute(storeDirectory) || typeof register !== "function"
      || !metadataBucket || !["get", "head", "put", "delete"].every(method => typeof metadataBucket[method] === "function"))
    throw new TypeError("Guix archive custody needs an absolute state directory, store and registrar");
  await mkdir(root, { recursive: true, mode: 0o700 });
  root = await realpath(root);
  const keys = join(root, "keys"), allocations = join(root, "roots");
  await mkdir(keys, { recursive: true, mode: 0o700 });
  await mkdir(allocations, { recursive: true, mode: 0o700 });
  await syncDirectory(root);
  if (collectorDirectory !== undefined) {
    if (!isAbsolute(collectorDirectory)) throw new TypeError("collector directory must be absolute");
    await mkdir(collectorDirectory, { mode: 0o755, recursive: true });
    collectorDirectory = await realpath(collectorDirectory);
  }
  const collectorRoot = allocation => collectorDirectory
    ? join(collectorDirectory, basename(allocation))
    : join(allocation, "archive");
  const entry = key => join(keys, digest("sha256", key, "hex") + ".json");

  async function record(path, key) {
    let value;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (existsError(error, "ENOENT")) return null;
      throw error;
    }
    if (value?.key !== key || !allocationName.test(value.allocation ?? "")
        || typeof value.storePath !== "string" || dirname(value.storePath) !== storeDirectory
        || !Number.isSafeInteger(value.size) || value.size < 1 || !/^[0-9a-f]{64}$/u.test(value.etag)
        || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value.customMetadata?.integrity ?? ""))
      throw new TypeError("invalid Guix archive custody receipt");
    return value;
  }

  function view(value) {
    return {
      key: value.key,
      size: value.size,
      etag: value.etag,
      httpEtag: '"' + value.etag + '"',
      customMetadata: value.customMetadata,
      httpMetadata: value.httpMetadata,
    };
  }

  async function readArchive(key, includeBody) {
    const path = entry(key);
    while (true) {
      const value = await record(path, key);
      if (value === null) return null;
      const registered = collectorRoot(join(allocations, value.allocation));
      let file;
      try {
        if (await realpath(registered) !== value.storePath)
          throw new Error("Guix archive root does not match its custody receipt");
        if (!includeBody) {
          const stat = await lstat(value.storePath);
          if (!stat.isFile() || stat.size !== value.size) throw new Error("Guix archive size differs");
          return view(value);
        }
        file = await open(value.storePath, "r");
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== value.size) throw new Error("Guix archive size differs");
        return { ...view(value), body: Readable.toWeb(file.createReadStream()) };
      } catch (error) {
        if (file) await file.close();
        if (existsError(error, "ENOENT") && (await record(path, key))?.allocation !== value.allocation)
          continue;
        throw error;
      }
    }
  }

  async function putArchive(key, value, { onlyIf, customMetadata = {}, httpMetadata = {} } = {}) {
    if (onlyIf?.etagDoesNotMatch !== "*" || Object.keys(onlyIf).length !== 1)
      throw new TypeError("Guix archives require create-once writes");
    if (await record(entry(key), key) !== null) return null;
    const bytes = Buffer.from(value);
    if (bytes.length === 0) throw new TypeError("empty package archive");
    const integrity = "sha512-" + digest("sha512", bytes, "base64");
    if (customMetadata.integrity !== undefined && customMetadata.integrity !== integrity)
      throw new TypeError("package archive bytes differ from the expected integrity");
    const allocation = await mkdtemp(join(allocations, "archive-"));
    let published = false;
    try {
      const source = join(allocation, "archive.tgz"), registered = collectorRoot(allocation);
      await writeFile(source, bytes, { flag: "wx", mode: 0o600 });
      const storePath = await register(source, registered);
      if (typeof storePath !== "string" || dirname(storePath) !== storeDirectory
          || await realpath(registered) !== storePath
          || !(await lstat(storePath)).isFile()
          || await fileIntegrity(storePath) !== integrity)
        throw new Error("registered Guix archive differs from the accepted package");
      await unlink(source);
      const stored = {
        key, allocation: basename(allocation), storePath, size: bytes.length,
        etag: digest("sha256", bytes, "hex"), customMetadata: { ...customMetadata, integrity }, httpMetadata,
      };
      const staged = join(allocation, "receipt.json");
      await writeFile(staged, JSON.stringify(stored), { flag: "wx", mode: 0o600, flush: true });
      await syncDirectory(allocation);
      await syncDirectory(allocations);
      if (collectorDirectory) await syncDirectory(collectorDirectory);
      try {
        await link(staged, entry(key));
      } catch (error) {
        if (existsError(error, "EEXIST")) return null;
        throw error;
      }
      published = true;
      await syncDirectory(keys);
      return view(stored);
    } finally {
      if (!published) {
        if (collectorDirectory) await rm(collectorRoot(allocation), { force: true });
        await rm(allocation, { recursive: true, force: true });
      }
    }
  }

  async function deleteArchive(key) {
    const removed = await mkdtemp(join(keys, "retired-"));
    try {
      const path = join(removed, "receipt.json");
      try {
        await rename(entry(key), path);
      } catch (error) {
        if (existsError(error, "ENOENT")) return;
        throw error;
      }
      await syncDirectory(keys);
      const value = await record(path, key);
      const allocation = join(allocations, value.allocation);
      if (collectorDirectory) {
        await rm(collectorRoot(allocation), { force: true });
        await syncDirectory(collectorDirectory);
      }
      await rm(allocation, { recursive: true, force: true });
      await syncDirectory(allocations);
    } finally {
      await rm(removed, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    get: key => isPackageArchiveKey(key) ? readArchive(key, true) : metadataBucket.get(key),
    head: key => isPackageArchiveKey(key) ? readArchive(key, false) : metadataBucket.head(key),
    put: (key, value, options) => isPackageArchiveKey(key) ? putArchive(key, value, options) : metadataBucket.put(key, value, options),
    delete: key => isPackageArchiveKey(key) ? deleteArchive(key) : metadataBucket.delete(key),
  });
}
