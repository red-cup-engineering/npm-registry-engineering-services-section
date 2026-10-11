import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PackageRegistrySnapshotVerificationError,
  verifyPackageRegistrySnapshot,
} from "../scripts/verify-package-registry-snapshot.mjs";

const REGISTRY = "https://registry.example.test/catalog/";

function release({ name, version, bytes, dependencies }) {
  const scoped = name.startsWith("@");
  const [scope, scopedLeaf] = scoped ? name.slice(1).split("/") : [null, name];
  const artifact = `tarballs/${scoped ? `${scope}/` : ""}${scopedLeaf}/-/${scopedLeaf}-${version}.tgz`;
  const shasum = createHash("sha1").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return {
    artifact,
    entry: { name, version, artifact, tarball: new URL(artifact, REGISTRY).href, bytes: bytes.byteLength, shasum, integrity },
    manifest: { name, version, ...(dependencies ? { dependencies } : {}), dist: { tarball: new URL(artifact, REGISTRY).href, shasum, integrity } },
    bytes,
  };
}

async function writeSnapshot(root, releases) {
  for (const item of releases) {
    await mkdir(join(root, item.artifact, ".."), { recursive: true });
    await mkdir(join(root, "metadata"), { recursive: true });
    await writeFile(join(root, item.artifact), item.bytes);
    const metadataPath = join(root, "metadata", `${encodeURIComponent(item.entry.name)}.json`);
    let metadata = { _id: item.entry.name, name: item.entry.name, "dist-tags": {}, versions: {} };
    try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    metadata.versions[item.entry.version] = item.manifest;
    metadata["dist-tags"].latest = Object.keys(metadata.versions).sort((left, right) => {
      const a = left.split(".").map(Number), b = right.split(".").map(Number);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    }).at(-1);
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
  }
  const names = new Set(releases.map(({ entry }) => entry.name));
  const scopes = [...new Set([...names].filter((name) => name.startsWith("@")).map((name) => name.slice(1, name.indexOf("/"))))].sort();
  const receipt = { type: "SemioticVoxelPackageRegistryReceipt", version: 2, registry: REGISTRY, packages: releases.map(({ entry }) => entry), packageCount: names.size, scopes };
  await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
  return receipt;
}

async function withSnapshot(callback) {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-snapshot-verification-"));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("verifies a complete canonical receipt, metadata catalog, and tarball catalog", async () => {
  await withSnapshot(async (root) => {
    const alpha = release({ name: "@alpha/example", version: "1.0.0", bytes: Buffer.from("alpha") });
    const zeta = release({ name: "@zeta/example", version: "2.0.0", bytes: Buffer.from("zeta") });
    const plain = release({ name: "plain", version: "3.0.0", bytes: Buffer.from("plain") });
    await writeSnapshot(root, [zeta, plain, alpha]);
    const report = await verifyPackageRegistrySnapshot({ registryDirectory: root });
    assert.deepEqual(report, {
      type: "SemioticVoxelPackageRegistrySnapshotVerificationReport",
      version: 1,
      registry: REGISTRY,
      packageCount: 3,
      releaseCount: 3,
      scopes: ["alpha", "zeta"],
      releases: ["@alpha/example@1.0.0", "@zeta/example@2.0.0", "plain@3.0.0"],
    });
  });
});

test("rejects an unreceipted empty packument and non-builder packument base fields", async () => {
  await withSnapshot(async (root) => {
    const first = release({ name: "@example/widget", version: "1.0.0", bytes: Buffer.from("first") });
    const second = release({ name: "@example/widget", version: "1.0.1", bytes: Buffer.from("second") });
    await writeSnapshot(root, [first, second]);
    const metadataPath = join(root, "metadata", "%40example%2Fwidget.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata._id = "@example/not-widget";
    metadata["dist-tags"].latest = "1.0.0";
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    await writeFile(join(root, "metadata", "%40orphan%2Fempty.json"), `${JSON.stringify({
      _id: "@orphan/empty", name: "@orphan/empty", "dist-tags": {}, versions: {},
    })}\n`);
    const receipt = JSON.parse(await readFile(join(root, "registry-receipt.json"), "utf8"));
    receipt.registry = "https://registry.example.test/catalog/?not-a-base";
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    await assert.rejects(
      () => verifyPackageRegistrySnapshot({ registryDirectory: root }),
      (error) => {
        assert.ok(error instanceof PackageRegistrySnapshotVerificationError);
        const codes = error.defects.map(({ code }) => code);
        assert.ok(codes.includes("RECEIPT_REGISTRY_URL"));
        assert.ok(codes.includes("METADATA_ID"));
        assert.ok(codes.includes("METADATA_DIST_TAG_LATEST"));
        assert.ok(codes.includes("UNRECEIPTED_METADATA_PACKAGE"));
        return true;
      },
    );
  });
});

test("reports receipt digest, metadata identity, local protocol, and orphan tarball defects together", async () => {
  await withSnapshot(async (root) => {
    const item = release({ name: "@example/widget", version: "1.0.0", bytes: Buffer.from("expected"), dependencies: { "@example/local": "workspace:*" } });
    const receipt = await writeSnapshot(root, [item]);
    receipt.packages[0].shasum = "wrong";
    receipt.scopes = [];
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    await mkdir(join(root, "tarballs", "orphan"), { recursive: true });
    await writeFile(join(root, "tarballs", "orphan", "extra.tgz"), "orphan");
    await assert.rejects(
      () => verifyPackageRegistrySnapshot({ registryDirectory: root }),
      (error) => {
        assert.ok(error instanceof PackageRegistrySnapshotVerificationError);
        assert.deepEqual(error.defects.map(({ code }) => code).sort(), [
          "LOCAL_DEPENDENCY_PROTOCOL",
          "METADATA_DIST_MISMATCH",
          "RECEIPT_ARTIFACT_DIGEST",
          "RECEIPT_SCOPES",
          "UNRECEIPTED_TARBALL",
        ]);
        assert.equal(error.defects.find(({ code }) => code === "LOCAL_DEPENDENCY_PROTOCOL").constraint, "workspace:*");
        return true;
      },
    );
  });
});

test("rejects duplicate and unreceipted releases, receipt-only releases, and bad canonical paths", async () => {
  await withSnapshot(async (root) => {
    const first = release({ name: "@example/widget", version: "1.0.0", bytes: Buffer.from("first") });
    const second = release({ name: "@example/widget", version: "1.0.1", bytes: Buffer.from("second") });
    const receipt = await writeSnapshot(root, [first, second]);
    receipt.packages.push({ ...first.entry });
    receipt.packages[1].artifact = "../outside.tgz";
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    const metadataPath = join(root, "metadata", "%40example%2Fwidget.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    delete metadata.versions["1.0.1"];
    metadata.versions["1.2.0"] = { ...first.manifest, version: "1.2.0" };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    await assert.rejects(
      () => verifyPackageRegistrySnapshot({ registryDirectory: root }),
      (error) => {
        assert.ok(error instanceof PackageRegistrySnapshotVerificationError);
        const codes = error.defects.map(({ code }) => code);
        assert.ok(codes.includes("DUPLICATE_RECEIPT_RELEASE"));
        assert.ok(codes.includes("ARTIFACT_OUTSIDE_ROOT"));
        assert.ok(codes.includes("UNRECEIPTED_METADATA_RELEASE"));
        assert.ok(codes.includes("RECEIPT_RELEASE_WITHOUT_METADATA"));
        return true;
      },
    );
  });
});

test("refuses registry receipt symlinks whether their targets are inside or outside the registry root", async () => {
  for (const targetKind of ["internal", "external"]) {
    await withSnapshot(async (root) => {
      const item = release({ name: "@example/widget", version: "1.0.0", bytes: Buffer.from("receipt") });
      await writeSnapshot(root, [item]);
      const targetDirectory = targetKind === "internal" ? root : await mkdtemp(join(tmpdir(), "npm-registry-snapshot-receipt-target-"));
      try {
        const target = join(targetDirectory, "receipt.json");
        await writeFile(target, await readFile(join(root, "registry-receipt.json")));
        await rm(join(root, "registry-receipt.json"));
        await symlink(target, join(root, "registry-receipt.json"));
        await assert.rejects(
          () => verifyPackageRegistrySnapshot({ registryDirectory: root }),
          (error) => error instanceof PackageRegistrySnapshotVerificationError
            && error.defects.some(({ code }) => code === "RECEIPT_NOT_REGULAR_UNDER_ROOT"),
        );
      } finally {
        if (targetKind === "external") await rm(targetDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("refuses canonical metadata symlinks whether their targets are inside or outside the registry root", async () => {
  for (const targetKind of ["internal", "external"]) {
    await withSnapshot(async (root) => {
      const item = release({ name: "@example/widget", version: "1.0.0", bytes: Buffer.from("metadata") });
      await writeSnapshot(root, [item]);
      const targetDirectory = targetKind === "internal" ? root : await mkdtemp(join(tmpdir(), "npm-registry-snapshot-metadata-target-"));
      try {
        const metadataPath = join(root, "metadata", "%40example%2Fwidget.json");
        const target = join(targetDirectory, "metadata.json");
        await writeFile(target, await readFile(metadataPath));
        await rm(metadataPath);
        await symlink(target, metadataPath);
        await assert.rejects(
          () => verifyPackageRegistrySnapshot({ registryDirectory: root }),
          (error) => error instanceof PackageRegistrySnapshotVerificationError
            && error.defects.some(({ code, file }) => code === "METADATA_NOT_REGULAR_UNDER_ROOT" && file === "%40example%2Fwidget.json"),
        );
      } finally {
        if (targetKind === "external") await rm(targetDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("rejects noncanonical metadata paths before attempting to parse them", async () => {
  await withSnapshot(async (root) => {
    const item = release({ name: "@example/widget", version: "1.0.0", bytes: Buffer.from("layout") });
    await writeSnapshot(root, [item]);
    await writeFile(join(root, "metadata", "Not-a-packument.json"), "this is not JSON");
    await assert.rejects(
      () => verifyPackageRegistrySnapshot({ registryDirectory: root }),
      (error) => error instanceof PackageRegistrySnapshotVerificationError
        && error.defects.some(({ code, file }) => code === "METADATA_FILE_LAYOUT" && file === "Not-a-packument.json")
        && !error.defects.some(({ code, file }) => code === "METADATA_JSON" && file === "Not-a-packument.json"),
    );
  });
});
