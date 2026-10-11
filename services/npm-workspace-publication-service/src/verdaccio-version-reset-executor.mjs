import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { link, mkdir, readFile, rename, rm, writeFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { rewriteVerdaccioPackument } from "./verdaccio-version-reset.mjs";
import { rewriteZeroMajorCarrier } from "./zero-major-version-reset.mjs";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";
const execFile = promisify(execFileCallback);
const json = value => JSON.stringify(value);
const filename = (name, version) => `${name.split("/").at(-1)}-${version}.tgz`;
const storagePath = (root, name, file) => {
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || file !== basename(file) || file === "..") throw new Error("invalid registry identity path");
  return join(root, ...name.split("/"), file);
};
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function hashes(path) {
  const sha512 = createHash("sha512"), sha1 = createHash("sha1");
  for await (const bytes of createReadStream(path)) { sha512.update(bytes); sha1.update(bytes); }
  return { integrity: `sha512-${sha512.digest("base64")}`, shasum: sha1.digest("hex") };
}
const atomicJSON = (path, value) => writeFileText(path, `${JSON.stringify(value, null, 2)}\n`);
async function backup(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  try { await link(source, destination); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await hashes(source)).integrity !== (await hashes(destination)).integrity) throw new Error(`backup collision: ${destination}`);
  }
}
async function extract(archive, work) {
  const { stdout } = await execFile("tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024 });
  for (const path of stdout.split("\n").filter(Boolean)) {
    if (!path.startsWith("package/") || path.split("/").includes("..") || path.includes("\\")) throw new Error(`unsafe tar entry: ${path}`);
  }
  await mkdir(work, { recursive: true });
  await execFile("tar", ["-xzf", archive, "--no-same-owner", "-C", work], { maxBuffer: 1024 * 1024 });
  return JSON.parse(await readFile(join(work, "package", "package.json"), "utf8"));
}

/** Offline transactional rewrite. The caller stops the registry during apply.
 * Original hardlinks and a durable state file permit retries after any swap.
 * Only metadata and embedded packaging descriptors change; application bytes
 * and file modes are retained. */
export async function applyVerdaccioZeroMajorReset({ storage, packuments, maps, backupRoot, registry = "https://registry.561.group/", failAfter = Infinity, onProgress = () => {} } = {}) {
  const root = resolve(storage), saved = resolve(backupRoot), statePath = join(saved, "state.json"), stage = join(saved, "staged");
  if (saved === root || saved.startsWith(root + "/")) throw new Error("backup must be outside served registry storage");
  const inputDigest = sha256Hex(json({ packuments, mappings: [...maps].map(([name, entries]) => [name, [...entries]]), registry }));
  let state;
  if (await exists(statePath)) {
    state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.inputDigest !== inputDigest || state.storage !== root) throw new Error("resume input differs from original version-reset plan");
  } else {
    // Check every snapshot before writing any served file.
    for (const p of packuments) {
      const actual = JSON.parse(await readFile(storagePath(root, p.name, "package.json"), "utf8"));
      if (json(actual) !== json(p)) throw new Error(`registry metadata changed since plan: ${p.name}`);
    }
    await mkdir(stage, { recursive: true });
    state = { version: 1, storage: root, inputDigest, phase: "staging", artifacts: [], metadata: [], removals: [] };
    await atomicJSON(statePath, state);
  }
  if (state.phase === "complete") {
    for (const record of state.metadata) if (sha256Hex(await readFile(record.target)) !== record.after) throw new Error(`completed metadata changed: ${record.target}`);
    for (const record of state.artifacts) if ((await hashes(record.target)).integrity !== record.integrity) throw new Error(`completed artifact changed: ${record.target}`);
    return { staged: 0, alreadyApplied: true, artifacts: state.artifacts };
  }
  if (state.phase === "staging") {
    const done = new Map(state.artifacts.map(record => [record.key, record]));
    for (const p of packuments) for (const [from, manifest] of Object.entries(p.versions)) {
      const key = `${p.name}\u0000${from}`, carrier = rewriteZeroMajorCarrier({ manifest }, maps), to = maps.get(p.name)?.get(from) ?? from;
      if (to === from && !carrier.dependencyEdits.length) continue;
      if (done.has(key)) {
        const record = done.get(key);
        if ((await hashes(record.output)).integrity !== record.integrity) throw new Error(`staged artifact changed: ${key}`);
        continue;
      }
      const oldFile = basename(new URL(manifest.dist.tarball, registry).pathname), newFile = filename(p.name, to);
      const source = storagePath(root, p.name, oldFile), target = storagePath(root, p.name, newFile), original = storagePath(join(saved, "original"), p.name, oldFile);
      await backup(source, original);
      const before = await hashes(original);
      if (manifest.dist.integrity?.startsWith("sha512-") && manifest.dist.integrity !== before.integrity) throw new Error(`original integrity mismatch: ${key}`);
      const work = join(stage, `work-${sha256Hex(key)}`), output = join(stage, `${sha256Hex(key)}.tgz`);
      await rm(work, { recursive: true, force: true });
      try {
        const embedded = await extract(original, work);
        if (embedded.name !== p.name || embedded.version !== from) throw new Error(`tarball identity mismatch: ${key}`);
        const rewritten = rewriteZeroMajorCarrier({ manifest: embedded }, maps).manifest;
        rewritten.version = to;
        await writeFile(join(work, "package", "package.json"), `${JSON.stringify(rewritten, null, 2)}\n`);
        for (const lockName of ["package-lock.json", "npm-shrinkwrap.json"]) {
          const path = join(work, "package", lockName);
          if (await exists(path)) {
            const packageLock = JSON.parse(await readFile(path, "utf8"));
            const lock = rewriteZeroMajorCarrier({ manifest: embedded, packageLock }, maps).packageLock;
            await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
          }
        }
        await execFile("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", output, "-C", work, "package"]);
        const { stdout } = await execFile("tar", ["-xOzf", output, "package/package.json"], { maxBuffer: 16 * 1024 * 1024 });
        const verified = JSON.parse(stdout);
        if (verified.name !== p.name || verified.version !== to) throw new Error(`staged identity mismatch: ${key}`);
      } finally { await rm(work, { recursive: true, force: true }); }
      const record = { key, name: p.name, from, version: to, filename: newFile, source, target, original, output,
        tarball: new URL(`${p.name}/-/${newFile}`, registry).href, ...await hashes(output), before: before.integrity };
      state.artifacts.push(record);
      await atomicJSON(statePath, state);
      onProgress({ phase: "staged", count: state.artifacts.length, name: p.name, from, to });
    }
    const artifacts = new Map(state.artifacts.map(record => [record.key, record]));
    state.metadata = [];
    for (const p of packuments) {
      const next = rewriteVerdaccioPackument(p, maps, { artifacts });
      if (json(next) === json(p)) continue;
      const target = storagePath(root, p.name, "package.json"), original = storagePath(join(saved, "original"), p.name, "package.json");
      const actual = await readFile(target);
      if (json(JSON.parse(actual)) !== json(p)) throw new Error(`registry metadata changed since plan: ${p.name}`);
      await backup(target, original);
      const output = join(stage, `${sha256Hex(p.name)}.json`);
      await atomicJSON(output, next);
      state.metadata.push({ target, original, output, before: sha256Hex(actual), after: sha256Hex(await readFile(output)) });
    }
    state.removals = state.artifacts.filter(record => record.source !== record.target).map(record => record.source);
    state.phase = "applying";
    await atomicJSON(statePath, state);
  }
  // Preflight all metadata again on resume; tolerate only our own final bytes.
  for (const record of state.metadata) {
    const actual = sha256Hex(await readFile(record.target));
    if (actual !== record.before && actual !== record.after) throw new Error(`concurrent registry edit: ${record.target}`);
  }
  let count = 0;
  for (const record of state.artifacts) {
    const actual = await exists(record.target) ? (await hashes(record.target)).integrity : null;
    if (actual !== record.integrity) {
      if (actual !== null && (record.source !== record.target || actual !== record.before)) throw new Error(`artifact target collision: ${record.target}`);
      // Keep the staged hardlink for reliable retries even after rename.
      const temporary = `${record.target}.${randomUUID()}.tmp`;
      await link(record.output, temporary); await rename(temporary, record.target);
    }
    if (++count === failAfter) throw new Error("injected partial failure");
  }
  for (const record of state.metadata) {
    if (sha256Hex(await readFile(record.target)) === record.after) continue;
    const temporary = `${record.target}.${randomUUID()}.tmp`;
    await link(record.output, temporary); await rename(temporary, record.target);
  }
  for (const path of state.removals) await rm(path, { force: true });
  state.phase = "complete";
  await atomicJSON(statePath, state);
  return { staged: state.artifacts.length, alreadyApplied: false, metadata: state.metadata.length, artifacts: state.artifacts };
}

