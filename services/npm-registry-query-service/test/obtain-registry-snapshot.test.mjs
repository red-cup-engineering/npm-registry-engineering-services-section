import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { obtainRegistrySnapshot } from "../src/obtain-registry-snapshot.mjs";

test("projects one receipt deterministically and refuses malformed receipt entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-registry-"));
  try {
    const receipt = {
      type: "SemioticVoxelPackageRegistryReceipt",
      version: 2,
      scopes: ["example"],
      packages: [{
        name: "@example/example",
        version: "1.0.0",
        artifact: "tarballs/example/example/-/example-1.0.0.tgz",
        bytes: 1,
        shasum: "one",
        integrity: "sha512-one",
        "x-semiotic-voxel": { actor: "urn:ame:receipt-example", operations: ["receipt-operation"] },
      }],
    };
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    const demand = { type: "PackageRegistrySnapshotDemand", requestId: "urn:demand:deterministic", registry: "https://registry.example.test/" };
    const environment = { registryRoot: root, registryUrl: "https://registry.example.test/" };
    const first = await obtainRegistrySnapshot(demand, environment);
    const second = await obtainRegistrySnapshot(demand, environment);
    assert.deepEqual(second, first);
    assert.equal(first.packages[0].declarationEvidence.sha256, first.receiptSha256);

    receipt.packages[0].artifact = "../tarballs/example/example/-/example-1.0.0.tgz";
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    await assert.rejects(() => obtainRegistrySnapshot(demand, environment), /exactly match its package coordinates/u);

    receipt.packages[0].artifact = "tarballs/example/other/-/other-1.0.0.tgz";
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    await assert.rejects(() => obtainRegistrySnapshot(demand, environment), /exactly match its package coordinates/u);

    receipt.packages[0].artifact = "tarballs/foreign/example/-/example-1.0.0.tgz";
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    await assert.rejects(() => obtainRegistrySnapshot(demand, environment), /exactly match its package coordinates/u);

    receipt.packages[0].name = "@example/not%2dcanonical";
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    await assert.rejects(() => obtainRegistrySnapshot(demand, environment), /scoped npm package name/u);

    receipt.packages[0].name = "@example/example";
    receipt.packages[0].version = "1.0.0-beta.1";
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    await assert.rejects(() => obtainRegistrySnapshot(demand, environment), /exact version/u);

    receipt.packages[0].version = "1.0.0";
    receipt.packages[0].artifact = "tarballs/example/example/-/example-1.0.0.tgz";
    receipt.type = "PackageRegistryReceipt";
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receipt)}\n`);
    await assert.rejects(() => obtainRegistrySnapshot(demand, environment), /no recognized snapshot receipt/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
