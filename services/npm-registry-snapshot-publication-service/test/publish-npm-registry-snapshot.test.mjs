import assert from "node:assert/strict";
import test from "node:test";

import { publishNpmRegistrySnapshot } from "../src/publish-npm-registry-snapshot.mjs";

test("requires explicit snapshot-pointer publication inputs", async () => {
  await assert.rejects(() => publishNpmRegistrySnapshot({}), /is required/u);
  await assert.rejects(
    () => publishNpmRegistrySnapshot({ packages: ["a"], hostDirectory: "h", snapshotName: "../bad", registryUrl: "http://registry.invalid/" }),
    /safe snapshot/u
  );
  await assert.rejects(
    () =>
      publishNpmRegistrySnapshot({
        packages: ["a"],
        hostDirectory: "h",
        snapshotName: "next",
        baseSnapshot: "../bad",
        registryUrl: "http://registry.invalid/",
      }),
    /safe snapshot/u
  );
});

test("composes an immutable named snapshot, base snapshot, and pointer activation through injected capabilities", async () => {
  let directory, request;
  const result = await publishNpmRegistrySnapshot(
    {
      packages: ["/sources/a", "/sources/b"],
      hostDirectory: "/host",
      snapshotName: "next",
      baseSnapshot: "previous",
      registryUrl: "https://registry.example/",
      concurrency: 2,
    },
    {
      async makeDirectory(path, options) {
        directory = { path, options };
      },
      async capabilityLoader() {
        return {
          async coordinate(value) {
            request = value;
            return { type: "PublishedSnapshot", registry: value.registryUrl, packageCount: 2, activation: { activeSnapshot: "next" } };
          },
          projectReleaseManifest() {},
          projectCarrier() {},
          pack() {},
          assemble() {},
          verify() {},
          activate() {},
        };
      },
    }
  );
  assert.deepEqual(directory, { path: "/host/snapshots", options: { recursive: true } });
  assert.equal(request.outputDirectory, "/host/snapshots/next");
  assert.equal(request.baseRegistryDirectory, "/host/snapshots/previous");
  assert.deepEqual(request.packageDirectories, ["/sources/a", "/sources/b"]);
  assert.deepEqual(request.activation, { hostDirectory: "/host", candidateName: "next" });
  assert.equal(request.dependencies.projectReleaseManifest instanceof Function, true);
  assert.deepEqual(result, { type: "PublishedSnapshot", registry: "https://registry.example/", packageCount: 2, activation: { activeSnapshot: "next" } });
});

test("omits the base-registry directory when no base snapshot is supplied", async () => {
  let request;
  await publishNpmRegistrySnapshot(
    { packages: ["/sources/a"], hostDirectory: "/host", snapshotName: "first", registryUrl: "https://registry.example/" },
    {
      async makeDirectory() {},
      async capabilityLoader() {
        return {
          async coordinate(value) {
            request = value;
            return { type: "PublishedSnapshot", registry: value.registryUrl, packageCount: 1, activation: { activeSnapshot: "first" } };
          },
          projectReleaseManifest() {},
          projectCarrier() {},
          pack() {},
          assemble() {},
          verify() {},
          activate() {},
        };
      },
    }
  );
  assert.equal(request.baseRegistryDirectory, undefined);
});
