import assert from "node:assert/strict";
import * as nativeFs from "node:fs/promises";
import { mkdtemp, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PackageRegistrySnapshotActivationError,
  activateVerifiedPackageRegistrySnapshot,
} from "../scripts/activate-verified-package-registry-snapshot.mjs";

const verification = Object.freeze({
  type: "SemioticVoxelPackageRegistrySnapshotVerificationReport",
  version: 1,
  releaseCount: 1,
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-snapshot-activation-"));
  await mkdir(join(root, "snapshots", "first"), { recursive: true });
  await mkdir(join(root, "snapshots", "second"), { recursive: true });
  return root;
}

function request(root, name, overrides = {}) {
  return {
    hostDirectory: root,
    candidate: { name, verification },
    ...overrides,
  };
}

async function withFixture(callback) {
  const root = await fixture();
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("atomically points current at the verified candidate and retains the prior active snapshot", async () => {
  await withFixture(async (root) => {
    const first = await activateVerifiedPackageRegistrySnapshot(request(root, "first"));
    assert.deepEqual(first, {
      type: "SemioticVoxelPackageRegistrySnapshotActivationResult",
      version: 1,
      activated: true,
      atomic: true,
      activeSnapshot: "first",
      previousSnapshot: null,
      lastGoodSnapshot: null,
    });
    const second = await activateVerifiedPackageRegistrySnapshot(request(root, "second"));
    assert.deepEqual(second, {
      type: "SemioticVoxelPackageRegistrySnapshotActivationResult",
      version: 1,
      activated: true,
      atomic: true,
      activeSnapshot: "second",
      previousSnapshot: "first",
      lastGoodSnapshot: "first",
    });
    assert.equal(await readlink(join(root, "current")), "snapshots/second");
    assert.equal(await readlink(join(root, "last-good")), "snapshots/first");
  });
});

test("is idempotent for the current candidate without rewriting the last-good pointer", async () => {
  await withFixture(async (root) => {
    await activateVerifiedPackageRegistrySnapshot(request(root, "first"));
    await activateVerifiedPackageRegistrySnapshot(request(root, "second"));
    const result = await activateVerifiedPackageRegistrySnapshot(request(root, "second"));
    assert.equal(result.activated, false);
    assert.equal(result.previousSnapshot, "second");
    assert.equal(await readlink(join(root, "last-good")), "snapshots/first");
  });
});

test("preserves an existing last-good pointer when there is no active pointer to supersede it", async () => {
  await withFixture(async (root) => {
    await symlink("snapshots/first", join(root, "last-good"));
    const result = await activateVerifiedPackageRegistrySnapshot(request(root, "second"));
    assert.equal(result.previousSnapshot, null);
    assert.equal(result.lastGoodSnapshot, "first");
    assert.equal(await readlink(join(root, "last-good")), "snapshots/first");
  });
});

test("rejects unverified candidates, escaping names, symlinked candidates, and unsafe pointers", async () => {
  await withFixture(async (root) => {
    await assert.rejects(() => activateVerifiedPackageRegistrySnapshot({ hostDirectory: root, candidate: { name: "first" } }), (error) => error.code === "CANDIDATE_NOT_VERIFIED");
    await assert.rejects(() => activateVerifiedPackageRegistrySnapshot(request(root, "../first")), (error) => error.code === "INVALID_SNAPSHOT_NAME");
    await symlink(join(root, "snapshots", "first"), join(root, "snapshots", "linked"));
    await assert.rejects(() => activateVerifiedPackageRegistrySnapshot(request(root, "linked")), (error) => error.code === "CANDIDATE_SNAPSHOT_UNAVAILABLE");
    await nativeFs.writeFile(join(root, "current"), "not a symlink");
    await assert.rejects(() => activateVerifiedPackageRegistrySnapshot(request(root, "first")), (error) => error.code === "UNSAFE_POINTER");
  });
});

test("does not replace current when the last-good pointer update fails and exposes deterministic failure", async () => {
  await withFixture(async (root) => {
    await activateVerifiedPackageRegistrySnapshot(request(root, "first"));
    const fs = { ...nativeFs, async rename(from, to) {
      if (to === join(root, "last-good")) throw Object.assign(new Error("simulated"), { code: "EIO" });
      return nativeFs.rename(from, to);
    } };
    await assert.rejects(
      () => activateVerifiedPackageRegistrySnapshot(request(root, "second", { filesystem: fs })),
      (error) => {
        assert.ok(error instanceof PackageRegistrySnapshotActivationError);
        assert.equal(error.code, "POINTER_REPLACE_FAILED");
        assert.deepEqual(error.detail, { pointer: "last-good" });
        return true;
      },
    );
    assert.equal(await readlink(join(root, "current")), "snapshots/first");
  });
});

test("uses injected filesystem hooks and rejects colliding or escaping pointer configuration", async () => {
  await withFixture(async (root) => {
    const operations = [];
    const fs = { ...nativeFs, async rename(from, to) { operations.push([from, to]); return nativeFs.rename(from, to); } };
    await activateVerifiedPackageRegistrySnapshot(request(root, "first", { filesystem: fs, nonce: "test" }));
    assert.deepEqual(operations.map(([, target]) => target), [join(root, "current")]);
    await assert.rejects(() => activateVerifiedPackageRegistrySnapshot(request(root, "first", { activePointer: "same", lastGoodPointer: "same" })), (error) => error.code === "POINTER_NAMES_COLLIDE");
    await assert.rejects(() => activateVerifiedPackageRegistrySnapshot(request(root, "first", { activePointer: "snapshots" })), (error) => error.code === "POINTER_NAMES_COLLIDE");
    await assert.rejects(() => activateVerifiedPackageRegistrySnapshot(request(root, "first", { activePointer: "" })), (error) => error.code === "INVALID_POINTER_NAME");
    await assert.rejects(() => activateVerifiedPackageRegistrySnapshot(request(root, "first", { activePointer: "../current" })), (error) => error.code === "INVALID_POINTER_NAME");
  });
});
