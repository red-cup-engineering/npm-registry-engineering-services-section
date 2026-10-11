import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deriveReplicatedPackageCopies, purgeIdenticalPackageReplicas } from "../src/replicated-package-copies.mjs";

async function pkg(path, name, version, files = {}) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), `${JSON.stringify({ name, version })}\n`);
  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFile(join(path, relativePath), contents);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("groups a replicated name, digests each copy, and partitions byte-identical copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "replicated-package-copies-"));
  try {
    await pkg(join(root, "a"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "b"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "c"), "@x/dup", "1.0.0", { "index.mjs": "different\n" });
    await pkg(join(root, "solo"), "@x/unique", "1.0.0", { "index.mjs": "only one\n" });

    const report = await deriveReplicatedPackageCopies({ root });

    assert.equal(report.kind, "npm.replicated-package-copies");
    assert.equal(report.groups.length, 1);
    const group = report.groups[0];
    assert.equal(group.name, "@x/dup");
    assert.equal(group.copies.length, 3);
    assert.equal(group.identicalSets.length, 1);
    assert.deepEqual(group.identicalSets[0], [join(root, "a"), join(root, "b")]);
    assert.equal(report.totals.groups, 1);
    assert.equal(report.totals.copies, 3);
    assert.equal(report.totals.identicalExtras, 1);
    const dupBytes = group.copies.find((copy) => copy.dir === join(root, "a")).bytes;
    assert.equal(report.totals.identicalExtraBytes, dupBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan keeps one copy of an identical set without touching disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "replicated-package-copies-plan-"));
  try {
    await pkg(join(root, "a"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "b"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "c"), "@x/dup", "1.0.0", { "index.mjs": "different\n" });

    const plan = await purgeIdenticalPackageReplicas({ root, apply: false });

    assert.equal(plan.kept.length, 1);
    assert.equal(plan.deleted.length, 1);
    assert.equal(plan.skipped.length, 0);
    assert.ok(await exists(join(root, "a")));
    assert.ok(await exists(join(root, "b")));
    assert.ok(await exists(join(root, "c")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply deletes the extra identical copy and leaves the differing copy and the kept copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "replicated-package-copies-apply-"));
  try {
    await pkg(join(root, "a"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "b"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "c"), "@x/dup", "1.0.0", { "index.mjs": "different\n" });

    const plan = await purgeIdenticalPackageReplicas({ root, apply: true });

    assert.equal(plan.deleted.length, 1);
    assert.equal(plan.kept[0], join(root, "a"));
    assert.ok(await exists(join(root, "a")));
    assert.ok(!(await exists(join(root, "b"))));
    assert.ok(await exists(join(root, "c")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps the live copy over a legacy copy even when the legacy path sorts first", async () => {
  const root = await mkdtemp(join(tmpdir(), "replicated-package-copies-legacy-"));
  try {
    await pkg(join(root, "lib", "legacy", "2020", "should-be-deleted"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "live", "keep-me"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });

    const report = await deriveReplicatedPackageCopies({ root });
    const group = report.groups[0];
    const legacyCopy = group.copies.find((copy) => copy.dir.includes("legacy"));
    const liveCopy = group.copies.find((copy) => copy.dir.includes("live"));
    assert.equal(legacyCopy.legacy, true);
    assert.equal(liveCopy.live, true);

    const plan = await purgeIdenticalPackageReplicas({ root, apply: true });
    assert.deepEqual(plan.kept, [join(root, "live", "keep-me")]);
    assert.equal(plan.deleted[0].dir, join(root, "lib", "legacy", "2020", "should-be-deleted"));
    assert.ok(!(await exists(join(root, "lib", "legacy", "2020", "should-be-deleted"))));
    assert.ok(await exists(join(root, "live", "keep-me")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to delete a copy referenced by another package.json's file: dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "replicated-package-copies-referenced-"));
  try {
    await pkg(join(root, "a"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "b"), "@x/dup", "1.0.0", { "index.mjs": "same\n" });
    await pkg(join(root, "consumer"), "@x/consumer", "1.0.0");
    await writeFile(
      join(root, "consumer", "package.json"),
      `${JSON.stringify({ name: "@x/consumer", version: "1.0.0", dependencies: { "@x/dup": "file:../b" } })}\n`,
    );

    const plan = await purgeIdenticalPackageReplicas({ root, apply: true });

    assert.equal(plan.deleted.length, 0);
    assert.equal(plan.kept.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.match(plan.skipped[0].reason, /file-dependency/);
    assert.ok(await exists(join(root, "a")));
    assert.ok(await exists(join(root, "b")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never partitions a unique digest into an identical set", async () => {
  const root = await mkdtemp(join(tmpdir(), "replicated-package-copies-uniques-"));
  try {
    await pkg(join(root, "a"), "@x/dup", "1.0.0", { "index.mjs": "one\n" });
    await pkg(join(root, "b"), "@x/dup", "1.0.0", { "index.mjs": "two\n" });

    const report = await deriveReplicatedPackageCopies({ root });
    assert.equal(report.groups[0].identicalSets.length, 0);

    const plan = await purgeIdenticalPackageReplicas({ root, apply: true });
    assert.equal(plan.deleted.length, 0);
    assert.equal(plan.kept.length, 0);
    assert.ok(await exists(join(root, "a")));
    assert.ok(await exists(join(root, "b")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
