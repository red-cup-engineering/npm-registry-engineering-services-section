import { assemblePackageRegistrySnapshot } from "@red-cup-engineering/npm-registry-snapshot-services-section/assemble-package-registry-snapshot";
import { closeServer, createPackageRegistryServer, listen } from "@red-cup-engineering/npm-registry-read-service";

export async function reconcilePackageLocksFromReleases({
  releases,
  snapshotDirectory,
  workspaceRoot,
  roots,
  registry,
  beforeWrite,
  assembly = assemblePackageRegistrySnapshot,
  createServer = createPackageRegistryServer,
  listenServer = listen,
  close = closeServer,
  reconcile,
  ...reconcileOptions
} = {}) {
  if (typeof reconcile !== "function") throw new TypeError("reconcilePackageLocksFromReleases: reconcile is required");
  if (!Array.isArray(releases) || releases.length === 0) throw new TypeError("releases must be a non-empty admitted carrier array");
  const server = createServer({ registryDirectory: snapshotDirectory });
  await listenServer(server, { host: "127.0.0.1", port: 0 });
  try {
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("snapshot read service did not expose a loopback address");
    const installationRegistry = `http://127.0.0.1:${address.port}/`;
    const snapshot = await assembly({ releases, outputDirectory: snapshotDirectory, registryUrl: installationRegistry });
    const lockReceipt = await reconcile({
      workspaceRoot,
      roots,
      registry,
      installationRegistry,
      token: "loopback-read-only-snapshot",
      beforeWrite,
      ...reconcileOptions,
    });
    return Object.freeze({ type: "NpmPackageLockSnapshotReconciliationReceipt", version: 1, snapshot, lockReceipt });
  } finally {
    await close(server);
  }
}
