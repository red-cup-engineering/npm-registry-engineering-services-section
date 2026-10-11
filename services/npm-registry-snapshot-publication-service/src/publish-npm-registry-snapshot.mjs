import { access, readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// Composes the release coordinator, manifest/carrier projection, packing,
// snapshot assembly/verification, and snapshot-activation capabilities into
// one bounded publication operation: build a named immutable registry
// snapshot in HOST/snapshots/NAME, verify it, then atomically advance
// HOST/current through the activation service. It never stops a server,
// swaps a live directory, polls HTTP, or generates graphs.

const SNAPSHOT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

function assertSafeSnapshotName(name, label) {
  if (typeof name !== "string" || !SNAPSHOT_NAME.test(name) || name === "." || name === "..") {
    throw new Error(`${label} must be a safe snapshot name`);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function validateReleaseBindings({ packages, baseRegistryDirectory }) {
  const batch = new Map();
  for (const { manifest } of packages) (batch.get(manifest.name) ?? batch.set(manifest.name, new Set()).get(manifest.name)).add(manifest.version);
  for (const { manifest } of packages) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      for (const [provider, requested] of Object.entries(manifest[field] ?? {})) {
        if (typeof requested !== "string" || !/^(?:workspace:|file:|link:)/u.test(requested)) continue;
        const binding = manifest.releasePlan?.dependencyBindings?.[provider];
        if (batch.get(provider)?.has(binding)) continue;
        const path = baseRegistryDirectory && join(baseRegistryDirectory, "metadata", `${encodeURIComponent(provider)}.json`);
        const metadata = path && (await exists(path)) ? JSON.parse(await readFile(path, "utf8")) : null;
        if (metadata?.versions?.[binding]?.name !== provider) {
          throw new Error(`coordinated release binding is unavailable: ${manifest.name} (${field}) ${provider}@${binding}`);
        }
      }
    }
  }
}

function localLeaseBroker() {
  return {
    async acquire({ requestedParallelism }) {
      return { provider: "urn:provider:local-node-process", parallelism: requestedParallelism, settlement: { type: "SelfSuppliedComputeCapacity" } };
    },
  };
}

async function loadPublicationCapabilities() {
  const [coordinator, manifest, carrier, packing, assembly, verification, activation] = await Promise.all([
    import("@red-cup-engineering/semiotic-npm-registry-services-section/npm-registry-release-coordinator-service"),
    import("@red-cup-engineering/semiotic-npm-registry-services-section/released-manifest"),
    import("@red-cup-engineering/semiotic-npm-registry-services-section/project-npm-carrier"),
    import("@red-cup-engineering/npm-package-services-section/pack-npm-package"),
    import("@red-cup-engineering/npm-registry-snapshot-services-section/assemble-package-registry-snapshot"),
    import("@red-cup-engineering/npm-registry-snapshot-services-section/verify-package-registry-snapshot"),
    import("@red-cup-engineering/npm-registry-snapshot-services-section/activate-verified-package-registry-snapshot"),
  ]);
  return {
    coordinate: coordinator.coordinateNpmRegistryRelease,
    projectReleaseManifest: manifest.releasedManifest,
    projectCarrier: carrier.projectNpmCarrier,
    pack: ({ carrierDirectory, destinationDirectory }) => packing.packNpmPackage({ type: "NpmPackagePackingRequest", version: 1, carrierDirectory, destinationDirectory }),
    assemble: assembly.assemblePackageRegistrySnapshot,
    verify: verification.verifyPackageRegistrySnapshot,
    activate: activation.activateVerifiedPackageRegistrySnapshot,
  };
}

/**
 * Builds a named immutable registry snapshot and atomically activates it
 * through snapshot pointers. Composes injected capabilities rather than
 * reimplementing discovery, projection, packing, assembly, verification, or
 * activation.
 */
export async function publishNpmRegistrySnapshot(options, { capabilityLoader = loadPublicationCapabilities, makeDirectory = mkdir } = {}) {
  if (!Array.isArray(options?.packages) || options.packages.length === 0) throw new Error("packages is required");
  if (typeof options.hostDirectory !== "string" || !options.hostDirectory) throw new Error("hostDirectory is required");
  if (typeof options.registryUrl !== "string" || !options.registryUrl) throw new Error("registryUrl is required");
  assertSafeSnapshotName(options.snapshotName, "snapshotName");
  if (options.baseSnapshot !== undefined) assertSafeSnapshotName(options.baseSnapshot, "baseSnapshot");

  const hostDirectory = resolve(options.hostDirectory);
  const snapshots = join(hostDirectory, "snapshots");
  const outputDirectory = join(snapshots, options.snapshotName);
  await makeDirectory(snapshots, { recursive: true });
  const capabilities = await capabilityLoader();

  return capabilities.coordinate({
    dependencies: {
      async discover() {
        throw new Error("publication requires explicit --package values");
      },
      validateReleaseBindings,
      projectReleaseManifest: capabilities.projectReleaseManifest,
      projectCarrier: capabilities.projectCarrier,
      pack: capabilities.pack,
      assemble: capabilities.assemble,
      async verify({ snapshotDirectory }) {
        return capabilities.verify({ registryDirectory: snapshotDirectory });
      },
      activate: capabilities.activate,
    },
    leaseBroker: localLeaseBroker(),
    packageDirectories: options.packages,
    outputDirectory,
    registryUrl: options.registryUrl,
    baseRegistryDirectory: options.baseSnapshot === undefined ? undefined : join(snapshots, options.baseSnapshot),
    concurrency: options.concurrency,
    activation: { hostDirectory, candidateName: options.snapshotName },
  });
}
