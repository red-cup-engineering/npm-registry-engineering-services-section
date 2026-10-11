import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Message, Role } from "@a2a-js/sdk";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { decodeSemanticEnvelope } from "@red-cup-engineering/computer-content-engineering-services-section/semantic-content-identity";
import { executeA2aMessage } from "../scripts/execute-a2a-task.mjs";
import { registrySnapshotProtocol } from "../src/protocol.mjs";
import { obtainRegistrySnapshot } from "../src/snapshot.mjs";

test("supplies a current snapshot only at its exact private registry face", async () => {
  const root = await mkdtemp(join(tmpdir(), "package-registry-"));
  try {
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "metadata"));
    await writeFile(join(root, "metadata", `${encodeURIComponent("@example/example")}.json`), `${JSON.stringify({
      name: "@example/example",
      versions: {
        "1.0.0": {
          name: "@example/example",
          version: "1.0.0",
          "x-semiotic-voxel": {
            actor: "urn:ame:example",
            operations: ["transform-example"],
            capabilities: [{ capability: "example", faces: ["transform-example"] }],
          },
          "x-agentic-metro-enterprise": {
            "node-id": "example",
            "operation-catalog": { "transform-example": { accepts: "input", returns: "output" } },
          },
          dist: { shasum: "one", integrity: "sha512-one" },
        },
      },
    })}\n`);
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify({
      type: "PackageRegistryReceipt",
      version: 1,
      scopes: ["example"],
      packages: [{
        name: "@example/example",
        version: "1.0.0",
        artifact: "tarballs/example/example/-/example-1.0.0.tgz",
        bytes: 1,
        shasum: "one",
        integrity: "sha512-one",
      }],
    })}\n`);
    const snapshot = await obtainRegistrySnapshot({ type: "PackageRegistrySnapshotDemand", requestId: "urn:demand:one", registry: "http://registry.example.test/" }, { registryRoot: root, registryUrl: "http://registry.example.test/" });
    assert.equal(snapshot.packages[0].tarball, "http://registry.example.test/tarballs/example/example/-/example-1.0.0.tgz");
    assert.equal(snapshot.packages[0]["x-semiotic-voxel"].actor, "urn:ame:example");
    assert.deepEqual(snapshot.packages[0]["x-semiotic-voxel"].operations, ["transform-example"]);
    assert.deepEqual(Object.keys(snapshot.packages[0]["x-agentic-metro-enterprise"]["operation-catalog"]), ["transform-example"]);
    assert.equal(snapshot.packages[0].declarationEvidence.source, "npm-version-metadata");
    assert.match(snapshot.packages[0].declarationEvidence.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.match(snapshot.npmrc, /@example:registry=http:\/\/registry.example.test\//u);

    const request = registrySnapshotProtocol.encodeRequest("obtain-package-registry-snapshot", {
      type: "PackageRegistrySnapshotDemand",
      requestId: "urn:demand:a2a",
      registry: "http://registry.example.test/",
    });
    const responseMessage = await executeA2aMessage(Message.toJSON({
      messageId: "urn:message:a2a",
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [rmnPart(request.bytes)],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    }), {
      REGISTRY_ROOT: root,
      REGISTRY_URL: "http://registry.example.test/",
    });
    const response = registrySnapshotProtocol.decodeResponse(decodeSemanticEnvelope(extractRmnPart(Message.fromJSON(responseMessage).parts).bytes).envelope.settledBody);
    assert.equal(response.disposition, "accepted");
    assert.deepEqual(response.result.packages[0]["x-semiotic-voxel"], snapshot.packages[0]["x-semiotic-voxel"]);
    assert.deepEqual(response.result.packages[0]["x-agentic-metro-enterprise"], snapshot.packages[0]["x-agentic-metro-enterprise"]);

    const receiptBound = {
      type: "PackageRegistryReceipt",
      scopes: ["example"],
      packages: [{
        name: "@example/example",
        version: "1.0.0",
        artifact: "tarballs/example/example/-/example-1.0.0.tgz",
        bytes: 1,
        shasum: "one",
        integrity: "sha512-one",
        "x-semiotic-voxel": { actor: "urn:ame:receipt-example", operations: ["receipt-operation"] },
        "x-agentic-metro-enterprise": { "node-id": "receipt-example", "operation-catalog": { "other-operation": {} } },
      }],
    };
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receiptBound)}\n`);
    const receiptSnapshot = await obtainRegistrySnapshot({ type: "PackageRegistrySnapshotDemand", requestId: "urn:demand:receipt", registry: "http://registry.example.test/" }, { registryRoot: root, registryUrl: "http://registry.example.test/" });
    assert.deepEqual(receiptSnapshot.packages[0]["x-semiotic-voxel"], receiptBound.packages[0]["x-semiotic-voxel"]);
    assert.deepEqual(receiptSnapshot.packages[0]["x-agentic-metro-enterprise"], receiptBound.packages[0]["x-agentic-metro-enterprise"]);
    assert.equal(receiptSnapshot.packages[0].declarationEvidence.source, "registry-receipt");
    assert.equal(receiptSnapshot.packages[0].declarationEvidence.sha256, receiptSnapshot.receiptSha256);

    delete receiptBound.packages[0]["x-agentic-metro-enterprise"];
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receiptBound)}\n`);
    const partialReceiptSnapshot = await obtainRegistrySnapshot({ type: "PackageRegistrySnapshotDemand", requestId: "urn:demand:partial-receipt", registry: "http://registry.example.test/" }, { registryRoot: root, registryUrl: "http://registry.example.test/" });
    assert.deepEqual(partialReceiptSnapshot.packages[0]["x-semiotic-voxel"], receiptBound.packages[0]["x-semiotic-voxel"]);
    assert.equal(partialReceiptSnapshot.packages[0]["x-agentic-metro-enterprise"], undefined);
    assert.equal(partialReceiptSnapshot.packages[0].declarationEvidence.source, "registry-receipt");

    delete receiptBound.packages[0]["x-semiotic-voxel"];
    await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify(receiptBound)}\n`);
    const metadataPath = join(root, "metadata", `${encodeURIComponent("@example/example")}.json`);
    const mismatchedMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
    mismatchedMetadata.versions["1.0.0"].dist.integrity = "sha512-other";
    await writeFile(metadataPath, `${JSON.stringify(mismatchedMetadata)}\n`);
    await assert.rejects(
      () => obtainRegistrySnapshot({ type: "PackageRegistrySnapshotDemand", requestId: "urn:demand:mismatch", registry: "http://registry.example.test/" }, { registryRoot: root, registryUrl: "http://registry.example.test/" }),
      /metadata artifact does not match registry receipt/u,
    );
    await assert.rejects(() => obtainRegistrySnapshot({ type: "PackageRegistrySnapshotDemand", requestId: "urn:demand:two", registry: "http://foreign.example/" }, { registryRoot: root, registryUrl: "http://registry.example.test/" }), /exact private registry face/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
