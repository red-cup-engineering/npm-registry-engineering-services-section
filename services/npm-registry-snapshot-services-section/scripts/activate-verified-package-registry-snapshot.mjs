import { lstat, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9._-]*$/iu;
const VERIFICATION_TYPE = "SemioticVoxelPackageRegistrySnapshotVerificationReport";

export class PackageRegistrySnapshotActivationError extends Error {
  constructor(code, detail = {}) {
    super(`package registry snapshot activation failed: ${code}`);
    this.name = "PackageRegistrySnapshotActivationError";
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

function activationError(code, detail) {
  return new PackageRegistrySnapshotActivationError(code, detail);
}

function isInside(root, candidate) {
  const displacement = relative(root, candidate);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement));
}

function name(value, field) {
  if (typeof value !== "string" || !SNAPSHOT_NAME.test(value) || value === "." || value === "..") {
    throw activationError("INVALID_SNAPSHOT_NAME", { field });
  }
  return value;
}

function entryName(value, field) {
  if (typeof value !== "string" || !value || basename(value) !== value || value === "." || value === "..") {
    throw activationError("INVALID_POINTER_NAME", { field });
  }
  return value;
}

function verified(candidate) {
  const report = candidate?.verification;
  if (report?.type !== VERIFICATION_TYPE || report?.version !== 1 || !Number.isInteger(report?.releaseCount) || report.releaseCount < 0) {
    throw activationError("CANDIDATE_NOT_VERIFIED");
  }
}

function filesystemHooks(filesystem) {
  const hooks = filesystem ?? { lstat, readlink, realpath, rename, symlink, unlink };
  for (const method of ["lstat", "readlink", "realpath", "rename", "symlink", "unlink"]) {
    if (typeof hooks[method] !== "function") throw new TypeError(`filesystem.${method} must be a function`);
  }
  return hooks;
}

async function realDirectory(fs, path, code, detail) {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw activationError(code, detail);
    return await fs.realpath(path);
  } catch (error) {
    if (error instanceof PackageRegistrySnapshotActivationError) throw error;
    if (error?.code === "ENOENT") throw activationError(code, detail);
    throw activationError("FILESYSTEM_FAILURE", { operation: "realpath-directory", ...detail });
  }
}

async function pointerTarget(fs, pointer, snapshotsReal, pointerName) {
  try {
    const stat = await fs.lstat(pointer);
    if (!stat.isSymbolicLink()) throw activationError("UNSAFE_POINTER", { pointer: pointerName });
    const target = await fs.realpath(pointer);
    if (!isInside(snapshotsReal, target)) throw activationError("POINTER_OUTSIDE_SNAPSHOTS", { pointer: pointerName });
    return target;
  } catch (error) {
    if (error instanceof PackageRegistrySnapshotActivationError) throw error;
    if (error?.code === "ENOENT") return null;
    throw activationError("FILESYSTEM_FAILURE", { operation: "read-pointer", pointer: pointerName });
  }
}

async function replacePointer(fs, { hostReal, pointerName, targetReal, nonce }) {
  const pointer = join(hostReal, pointerName);
  const temporary = join(hostReal, `.${pointerName}.next-${nonce}`);
  const target = relative(hostReal, targetReal) || ".";
  try {
    await fs.symlink(target, temporary);
    await fs.rename(temporary, pointer);
  } catch (error) {
    try { await fs.unlink(temporary); } catch (cleanup) { if (cleanup?.code !== "ENOENT") { /* best-effort cleanup */ } }
    if (error instanceof PackageRegistrySnapshotActivationError) throw error;
    throw activationError("POINTER_REPLACE_FAILED", { pointer: pointerName });
  }
}

// This is intentionally a host-local hand-off only. `candidate.verification`
// is the report returned by the snapshot-verification service; callers must
// keep the candidate immutable between verification and this pointer update.
export async function activateVerifiedPackageRegistrySnapshot({
  hostDirectory,
  snapshotDirectory = "snapshots",
  candidate,
  activePointer = "current",
  lastGoodPointer = "last-good",
  filesystem,
  nonce = "activation",
}) {
  verified(candidate);
  const fs = filesystemHooks(filesystem);
  const snapshotName = name(candidate?.name, "candidate.name");
  const snapshotsName = entryName(snapshotDirectory, "snapshotDirectory");
  const activeName = entryName(activePointer, "activePointer");
  const lastGoodName = entryName(lastGoodPointer, "lastGoodPointer");
  if (activeName === lastGoodName || snapshotsName === activeName || snapshotsName === lastGoodName) {
    throw activationError("POINTER_NAMES_COLLIDE");
  }
  if (typeof hostDirectory !== "string" || !hostDirectory) throw activationError("INVALID_HOST_DIRECTORY");
  if (typeof nonce !== "string" || !nonce || /[\\/]/u.test(nonce)) throw activationError("INVALID_NONCE");

  const hostReal = await realDirectory(fs, resolve(hostDirectory), "HOST_DIRECTORY_UNAVAILABLE");
  const snapshots = join(hostReal, snapshotsName);
  const snapshotsReal = await realDirectory(fs, snapshots, "SNAPSHOT_DIRECTORY_UNAVAILABLE");
  const candidatePath = join(snapshotsReal, snapshotName);
  const candidateReal = await realDirectory(fs, candidatePath, "CANDIDATE_SNAPSHOT_UNAVAILABLE", { snapshot: snapshotName });
  if (!isInside(snapshotsReal, candidateReal) || candidateReal === snapshotsReal) {
    throw activationError("CANDIDATE_OUTSIDE_SNAPSHOTS", { snapshot: snapshotName });
  }

  const activePath = join(hostReal, activeName);
  const previousReal = await pointerTarget(fs, activePath, snapshotsReal, activeName);
  const existingLastGoodReal = await pointerTarget(fs, join(hostReal, lastGoodName), snapshotsReal, lastGoodName);
  if (previousReal === candidateReal) {
    return Object.freeze({
      type: "SemioticVoxelPackageRegistrySnapshotActivationResult",
      version: 1,
      activated: false,
      atomic: true,
      activeSnapshot: snapshotName,
      previousSnapshot: snapshotName,
      lastGoodSnapshot: existingLastGoodReal ? basename(existingLastGoodReal) : null,
    });
  }

  // Both temporary pointers live beside their final names. POSIX rename in
  // one directory atomically replaces each pointer; there is never a period
  // in which `current` names no snapshot.
  const previousName = previousReal ? basename(previousReal) : null;
  if (previousReal) await replacePointer(fs, { hostReal, pointerName: lastGoodName, targetReal: previousReal, nonce });
  await replacePointer(fs, { hostReal, pointerName: activeName, targetReal: candidateReal, nonce });
  return Object.freeze({
    type: "SemioticVoxelPackageRegistrySnapshotActivationResult",
    version: 1,
    activated: true,
    atomic: true,
    activeSnapshot: snapshotName,
    previousSnapshot: previousName,
    lastGoodSnapshot: previousName ?? (existingLastGoodReal ? basename(existingLastGoodReal) : null),
  });
}
