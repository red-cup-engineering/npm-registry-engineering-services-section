import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePackageLocksFromReleases } from "../src/reconcile-package-locks-from-releases.mjs";

test("reconcile is a required capability", async () => {
  await assert.rejects(reconcilePackageLocksFromReleases({
    releases: [{}], snapshotDirectory: "/tmp/snapshot", workspaceRoot: "/source", roots: [{}], registry: "https://registry.example/",
  }), /reconcile is required/u);
});

test("composes admitted releases through the snapshot and read owners before reconciliation", async () => {
  const calls = [];
  const server = { address: () => ({ port: 43123 }) };
  const result = await reconcilePackageLocksFromReleases({
    releases: [{ manifest: { name: "one", version: "1.0.0" }, artifactPath: "/admission/one.tgz", integrity: "sha512-claim" }],
    snapshotDirectory: "/tmp/snapshot",
    workspaceRoot: "/source",
    roots: [{ id: "one", path: "packages/one" }],
    registry: "https://registry.example.test/npm/",
    createServer: ({ registryDirectory }) => { calls.push(["create", registryDirectory]); return server; },
    listenServer: async (value, options) => { assert.equal(value, server); calls.push(["listen", options]); },
    assembly: async (options) => { calls.push(["assemble", options]); return { type: "snapshot" }; },
    reconcile: async (options) => { calls.push(["reconcile", options]); return { type: "locks" }; },
    close: async (value) => { assert.equal(value, server); calls.push(["close"]); },
  });
  assert.equal(calls.find(([name]) => name === "assemble")[1].registryUrl, "http://127.0.0.1:43123/");
  const reconciliation = calls.find(([name]) => name === "reconcile")[1];
  assert.equal(reconciliation.installationRegistry, "http://127.0.0.1:43123/");
  assert.equal(reconciliation.registry, "https://registry.example.test/npm/");
  assert.deepEqual(calls.map(([name]) => name), ["create", "listen", "assemble", "reconcile", "close"]);
  assert.deepEqual(result, { type: "NpmPackageLockSnapshotReconciliationReceipt", version: 1, snapshot: { type: "snapshot" }, lockReceipt: { type: "locks" } });
});

test("a snapshot or reconciliation refusal still closes the read face", async () => {
  const server = { address: () => ({ port: 1 }) };
  let closed = 0;
  await assert.rejects(reconcilePackageLocksFromReleases({
    releases: [{}], snapshotDirectory: "/tmp/snapshot", workspaceRoot: "/source", roots: [{}], registry: "https://registry.example/",
    createServer: () => server, listenServer: async () => {}, assembly: async () => { throw new Error("refused"); }, reconcile: async () => ({}), close: async () => { closed += 1; },
  }), /refused/u);
  assert.equal(closed, 1);
});
