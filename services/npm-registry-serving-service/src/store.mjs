import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { niPathSegments } from "@red-cup-engineering/computer-content-address-engineering-services-section/ni-path";
import { isNiUri, makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";
import { admittedRow, legacyRows } from "./facts.mjs";

/**
 * The registry's package store on disk, under one `storage` directory:
 *
 *   <name>/facts.jsonl            the package's facts (facts.mjs), one EAVT row per line, only ever appended
 *   -/blobs/sha-256/<d0d1>/<d>    every tarball once, named by its RFC 6920 SHA-256 NI address (the shared
 *                                 ni-path formula locates it; nothing indexes it)
 *   <name>/package.json           the packument as the earlier Verdaccio-layout store held it, and
 *   <name>/<file>.tgz             its tarballs (hard links to the blobs): a projection kept so that an earlier
 *                                 registry release, or Verdaccio, still serves this store
 *
 * A package with `package.json` and no journal is one the earlier store wrote: its packument is read as the facts it
 * records (legacyRows), in memory, until reception (reception.mjs) writes them down.
 *
 * Writers serialize per package, in process and across processes (a lock file beside the journal), so two serving
 * processes may share one store. Were a lock ever lost, a version's first publication still wins in every
 * projection, and tarballs are named by their bytes, so no published version could change.
 */
export const NI_PREFIX = "ni:///sha-256;";
const NEWLINE = 0x0a;

export function createPackageStore({ storage, lockWaitMs = 30_000, lockStaleMs = 120_000 }) {
  if (typeof storage !== "string" || storage === "") throw new TypeError("the package store needs its storage directory");
  const directoryOf = (name) => join(storage, name);
  const journalPath = (name) => join(storage, name, "facts.jsonl");
  const layoutPath = (name) => join(storage, name, "package.json");
  const leafPath = (name, file) => join(storage, name, file);
  const blobPath = (ni) => join(storage, "-", "blobs", ...niPathSegments(ni), ni.slice(NI_PREFIX.length));

  const statOf = async (path) => {
    try { return await stat(path); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined; throw error; }
  };
  const readBytes = async (path) => {
    try { return await readFile(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  };
  const digest = (bytes) => createHash("sha256").update(bytes).digest("base64url");

  /** What a package's documents are projected from now: its journal, else its earlier packument; with a key that
   *  changes whenever that file does. Undefined when the store holds neither. */
  async function sourceOf(name) {
    const journal = await statOf(journalPath(name));
    if (journal?.isFile()) return { kind: "journal", path: journalPath(name), key: `j:${journal.ino}:${journal.size}:${journal.mtimeMs}` };
    const layout = await statOf(layoutPath(name));
    if (layout?.isFile()) return { kind: "layout", path: layoutPath(name), key: `l:${layout.ino}:${layout.size}:${layout.mtimeMs}` };
    return undefined;
  }

  /** The package's facts: `{kind, rows, digest}`, where `digest` names exactly the bytes they were read from. A
   *  journal's last line is its own only once it ends; a line cut short by an interrupted append is not read. A
   *  complete line that is not a fact is refused, never skipped. */
  async function read(name) {
    const source = await sourceOf(name);
    if (source === undefined) return undefined;
    const bytes = await readBytes(source.path);
    if (bytes === undefined) return read(name);
    if (source.kind === "layout") {
      const packument = JSON.parse(bytes.toString("utf8"));
      return { kind: "layout", key: source.key, rows: legacyRows(name, packument), digest: digest(bytes), packument };
    }
    const complete = bytes.subarray(0, bytes.lastIndexOf(NEWLINE) + 1);
    const rows = complete.toString("utf8").split("\n").filter((line) => line !== "").map((line, index) => {
      try { return admittedRow(JSON.parse(line)); }
      catch (error) { throw new TypeError(`${journalPath(name)}:${index + 1} is not a registry fact (${error.message})`); }
    });
    return { kind: "journal", key: source.key, rows, digest: digest(complete) };
  }

  /** Append rows to the package's journal and make them durable. The caller holds the package's lock. An earlier
   *  append cut short is cut back to its last complete line first. */
  async function append(name, rows) {
    if (rows.length === 0) return;
    for (const row of rows) admittedRow(row);
    await mkdir(directoryOf(name), { recursive: true });
    const handle = await open(journalPath(name), "a+");
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== NEWLINE) await handle.truncate((await readFile(journalPath(name))).lastIndexOf(NEWLINE) + 1);
      }
      await handle.write(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8"));
      await handle.sync();
    } finally { await handle.close(); }
  }

  /** Replace a file whole: readers see the old bytes or the new, never part. */
  async function writeAtomic(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, bytes, { flag: "wx" });
      await rename(partial, path);
    } finally { await rm(partial, { force: true }); }
  }

  /** Give `path` exactly `bytes` without ever replacing other bytes there: an immutable name. */
  async function placeImmutable(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, bytes, { flag: "wx" });
      try { await link(partial, path); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (!(await readFile(path)).equals(bytes)) throw Object.assign(new Error(`${path} already has different bytes`), { code: "ARTIFACT_CONFLICT" });
      }
    } finally { await rm(partial, { force: true }); }
  }

  /** Keep bytes in the blob store under their NI address; returns the address. The same bytes are kept once. */
  async function storeBlob(bytes) {
    const ni = makeNiUri(bytes);
    const path = blobPath(ni);
    if (!(await statOf(path))?.isFile()) await placeImmutable(path, bytes);
    return ni;
  }

  /** A file's NI address, size, and npm's two digests (`integrity`, `shasum`), read once as a stream: a store of
   *  tarballs is measured without holding any of them. */
  async function measure(path) {
    const sha256 = createHash("sha256"), sha512 = createHash("sha512"), sha1 = createHash("sha1");
    let size = 0;
    for await (const chunk of createReadStream(path)) { sha256.update(chunk); sha512.update(chunk); sha1.update(chunk); size += chunk.length; }
    // The shared primitive spells NI from bytes; this is its spelling of the same digest, checked by it.
    const ni = `${NI_PREFIX}${sha256.digest("base64url")}`;
    if (!isNiUri(ni)) throw new Error(`${path} measured to a malformed NI address`);
    return { ni, size, integrity: `sha512-${sha512.digest("base64")}`, shasum: sha1.digest("hex") };
  }

  /** A file already in the store, measured, and kept in the blob store by hard link (no copy) unless `link` is
   *  false. */
  async function adoptBlob(path, { link: linked = true } = {}) {
    const measured = await measure(path);
    const target = blobPath(measured.ni);
    if (linked && !(await statOf(target))?.isFile()) {
      await mkdir(dirname(target), { recursive: true });
      try { await link(path, target); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    return measured;
  }

  /** Where a version's tarball bytes are: its blob, else its leaf in the package directory; undefined if neither. */
  async function artifactPath(name, artifact) {
    if (typeof artifact?.ni === "string" && isNiUri(artifact.ni)) {
      const path = blobPath(artifact.ni), info = await statOf(path);
      if (info?.isFile()) return { path, size: info.size };
    }
    if (typeof artifact?.file !== "string" || artifact.file.includes("/") || artifact.file.startsWith(".")) return undefined;
    const path = leafPath(name, artifact.file), info = await statOf(path);
    return info?.isFile() ? { path, size: info.size } : undefined;
  }

  /** Where the retired publisher left a scoped version's tarball: under npm's scoped attachment key
   *  (`<storage>/@scope/name/@scope/name-1.0.0.tgz`), not the leaf; undefined when it left none there. */
  async function scopedAttachmentPath(name, version) {
    if (!name.startsWith("@")) return undefined;
    const path = join(storage, name, `${name}-${version}.tgz`), info = await statOf(path);
    return info?.isFile() ? { path, size: info.size } : undefined;
  }

  /** Name an adopted blob at a package's leaf file too, so the earlier layout serves it; a leaf already there stays. */
  async function linkLeaf(name, file, ni) {
    try { await link(blobPath(ni), leafPath(name, file)); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }

  /** Name a blob at a package's leaf file as well, so the earlier layout serves it. Different bytes already there
   *  are a conflict; the same bytes are left as they are. */
  async function placeLeaf(name, file, ni, bytes) {
    const path = leafPath(name, file);
    try { await link(blobPath(ni), path); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await readFile(path)).equals(bytes)) throw Object.assign(new Error(`${file} already has different bytes`), { code: "ARTIFACT_CONFLICT" });
    }
  }

  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Hold the package's lock file for `work`. A lock whose holder has exited, or that is older than any write
   *  takes, is stale and taken over. */
  async function holdFileLock(name, work) {
    const directory = directoryOf(name);
    await mkdir(directory, { recursive: true });
    const path = join(directory, ".lock");
    const deadline = Date.now() + lockWaitMs;
    for (let delay = 5; ; delay = Math.min(delay * 2, 250)) {
      try {
        await writeFile(path, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
        break;
      } catch (error) {
        // Another writer's refused first publication removed the empty directory between our mkdir and our write.
        if (error.code === "ENOENT") { await mkdir(directory, { recursive: true }); continue; }
        if (error.code !== "EEXIST") throw error;
        const [pid, at] = (await readFile(path, "utf8").catch(() => "")).trim().split(" ");
        const holder = Number.parseInt(pid, 10);
        const stale = (Number.isSafeInteger(holder) && holder > 0 && holder !== process.pid && !alive(holder))
          || (at !== undefined && Date.now() - Date.parse(at) > lockStaleMs);
        if (stale) { await rm(path, { force: true }); continue; }
        if (Date.now() > deadline) throw Object.assign(new Error(`${name} is locked by another writer`), { code: "PACKAGE_LOCKED" });
        await sleep(delay);
      }
    }
    try { return await work(); }
    finally {
      await rm(path, { force: true });
      // A refused first publication leaves nothing behind, not even its directory.
      await rmdir(directory).catch(() => {});
    }
  }
  const queues = new Map();
  /** Run `work` holding the package's write lock: one writer per package, in this process and across processes. */
  function lock(name, work) {
    const next = (queues.get(name) ?? Promise.resolve()).then(() => holdFileLock(name, work), () => holdFileLock(name, work));
    const settled = next.catch(() => {});
    queues.set(name, settled);
    settled.then(() => { if (queues.get(name) === settled) queues.delete(name); });
    return next;
  }

  /** Every package directory's name (scoped names whole); names the store did not admit are not listed. */
  async function names() {
    const found = [];
    const entries = await readdir(storage, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("-") || entry.name.startsWith(".")) continue;
      if (!entry.name.startsWith("@")) { found.push(entry.name); continue; }
      for (const inner of await readdir(join(storage, entry.name), { withFileTypes: true })) {
        if (inner.isDirectory() && !inner.name.startsWith(".")) found.push(`${entry.name}/${inner.name}`);
      }
    }
    return found;
  }

  return Object.freeze({
    storage, read, sourceOf, append, lock, storeBlob, measure, adoptBlob, artifactPath, scopedAttachmentPath, linkLeaf, placeLeaf, names,
    readLeaf: (name, file) => readBytes(leafPath(name, file)),
    leafPath,
    readLayout: async (name) => { const bytes = await readBytes(layoutPath(name)); return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8")); },
    materialize: (name, document) => writeAtomic(layoutPath(name), JSON.stringify(document, null, 2)),
    preserveLayout: async (name, suffix) => { const path = layoutPath(name); await rename(path, `${path}.${suffix}`).catch((error) => { if (error.code !== "ENOENT") throw error; }); },
    writeAtomic,
  });
}
