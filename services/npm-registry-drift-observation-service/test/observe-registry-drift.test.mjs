import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePackageRegistryRequest } from "@red-cup-engineering/npm-registry-read-service";
import { observeRegistryDrift } from "../src/observe-registry-drift.mjs";

// Same technique registry-graph.test.mjs uses to exercise the HTTP face
// without a socket: an injected fetch backed by the registry server's own
// request resolver, so the URL shape and percent-encoding law under test are
// the real ones a live registry serves.
function registryFetch(registryDirectory) {
  return async (url) => {
    const target = await resolvePackageRegistryRequest({ registryDirectory, requestPath: new URL(url).pathname });
    if (target === null) return { ok: false, status: 404 };
    const body = await readFile(target);
    return { ok: true, status: 200, arrayBuffer: async () => body };
  };
}

async function writeFixtureRegistry(root) {
  await mkdir(join(root, "metadata"), { recursive: true });
  const manifests = {
    "@fixture/current-package": {
      name: "@fixture/current-package",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "@fixture/current-package",
          version: "1.0.0",
          dependencies: { leftpad: "1.2.3" },
        },
      },
    },
    "@fixture/stale-package": {
      name: "@fixture/stale-package",
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "2.0.0": {
          name: "@fixture/stale-package",
          version: "2.0.0",
          dependencies: { "@fixture/renamed-dep": "1.0.0", pinned: "6.0.0" },
        },
      },
    },
    "@fixture/unpublished-version-package": {
      name: "@fixture/unpublished-version-package",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": { name: "@fixture/unpublished-version-package", version: "1.0.0" },
      },
    },
    "@fixture/gone-from-source": {
      name: "@fixture/gone-from-source",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": { name: "@fixture/gone-from-source", version: "1.0.0" },
      },
    },
  };
  for (const [name, metadata] of Object.entries(manifests)) {
    await writeFile(join(root, "metadata", `${encodeURIComponent(name)}.json`), `${JSON.stringify(metadata)}\n`);
  }
  await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify({
    type: "SemioticVoxelPackageRegistryReceipt",
    version: 2,
    registry: "http://registry.fixture.test/",
    packages: [
      { name: "@fixture/current-package", version: "1.0.0" },
      { name: "@fixture/stale-package", version: "2.0.0" },
      { name: "@fixture/unpublished-version-package", version: "1.0.0" },
      { name: "@fixture/gone-from-source", version: "1.0.0" },
    ],
    scopes: ["fixture"],
  })}\n`);
}

async function writeFixtureSource(root) {
  await mkdir(join(root, "current-package"), { recursive: true });
  await writeFile(
    join(root, "current-package", "package.json"),
    JSON.stringify({ name: "@fixture/current-package", version: "1.0.0", dependencies: { leftpad: "1.2.3" } }),
  );
  // Dependency renamed on disk (@fixture/renamed-dep -> @fixture/new-dep) and
  // a literal pin bumped (6.0.0 -> 6.0.1) without a version bump — the two
  // symptoms actually observed against the live registry.
  await mkdir(join(root, "stale-package"), { recursive: true });
  await writeFile(
    join(root, "stale-package", "package.json"),
    JSON.stringify({ name: "@fixture/stale-package", version: "2.0.0", dependencies: { "@fixture/new-dep": "1.0.0", pinned: "6.0.1" } }),
  );
  // Source has moved on to 2.0.0 but the registry has never seen anything
  // past 1.0.0.
  await mkdir(join(root, "unpublished-version-package"), { recursive: true });
  await writeFile(
    join(root, "unpublished-version-package", "package.json"),
    JSON.stringify({ name: "@fixture/unpublished-version-package", version: "2.0.0" }),
  );
  // A package the registry has never heard of at all.
  await mkdir(join(root, "brand-new-package"), { recursive: true });
  await writeFile(
    join(root, "brand-new-package", "package.json"),
    JSON.stringify({ name: "@fixture/brand-new-package", version: "1.0.0" }),
  );
  // Note: no directory for @fixture/gone-from-source — the registry
  // publishes it, but nothing on disk declares it any longer.
}

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), "registry-drift-"));
  const sourceRoot = join(root, "source");
  const registryRoot = join(root, "registry");
  await mkdir(sourceRoot, { recursive: true });
  await writeFixtureSource(sourceRoot);
  await writeFixtureRegistry(registryRoot);
  return { root, sourceRoot, registryRoot };
}

test("classifies current, stale-manifest, unpublished, and source-missing packages", async () => {
  const { root, sourceRoot, registryRoot } = await fixtures();
  try {
    const observation = await observeRegistryDrift({
      root: sourceRoot,
      registryUrl: "http://registry.fixture.test",
      fetchImplementation: registryFetch(registryRoot),
    });

    assert.equal(observation.type, "RegistryDriftObservation");
    assert.equal(observation.receiptFound, true);

    const byName = Object.fromEntries(observation.findings.map((finding) => [finding.name, finding]));

    assert.equal(byName["@fixture/current-package"].verdict, "current");
    assert.deepEqual(byName["@fixture/current-package"].dependencyDrift, []);

    assert.equal(byName["@fixture/stale-package"].verdict, "stale-manifest");
    const drift = byName["@fixture/stale-package"].dependencyDrift;
    assert.equal(drift.length, 3);
    assert.ok(drift.some((d) => d.name === "@fixture/renamed-dep" && d.reason === "missing-in-source"));
    assert.ok(drift.some((d) => d.name === "@fixture/new-dep" && d.reason === "missing-in-published"));
    assert.ok(drift.some((d) => d.name === "pinned" && d.reason === "pin-mismatch" && d.source === "6.0.1" && d.published === "6.0.0"));

    assert.equal(byName["@fixture/unpublished-version-package"].verdict, "unpublished");
    assert.equal(byName["@fixture/unpublished-version-package"].sourceVersion, "2.0.0");
    assert.equal(byName["@fixture/unpublished-version-package"].publishedVersion, "1.0.0");

    assert.equal(byName["@fixture/brand-new-package"].verdict, "unpublished");
    assert.equal(byName["@fixture/brand-new-package"].publishedVersion, null);

    assert.equal(byName["@fixture/gone-from-source"].verdict, "source-missing");
    assert.equal(byName["@fixture/gone-from-source"].path, null);

    assert.deepEqual(observation.counts, { current: 1, "stale-manifest": 1, unpublished: 2, "source-missing": 1 });
    assert.equal(observation.findings.length, 5);
    assert.ok(Object.isFrozen(observation) && Object.isFrozen(observation.findings));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace: protocol pins never count as drift, only the rest of the field", async () => {
  const { root, sourceRoot, registryRoot } = await fixtures();
  try {
    await writeFile(
      join(sourceRoot, "current-package", "package.json"),
      JSON.stringify({ name: "@fixture/current-package", version: "1.0.0", dependencies: { leftpad: "workspace:*" } }),
    );
    const observation = await observeRegistryDrift({
      root: sourceRoot,
      registryUrl: "http://registry.fixture.test",
      fetchImplementation: registryFetch(registryRoot),
    });
    const finding = observation.findings.find((f) => f.name === "@fixture/current-package");
    assert.equal(finding.verdict, "current");
    assert.deepEqual(finding.dependencyDrift, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a registry with no receipt still classifies the packages it does answer for", async () => {
  const { root, sourceRoot, registryRoot } = await fixtures();
  try {
    await rm(join(registryRoot, "registry-receipt.json"));
    const observation = await observeRegistryDrift({
      root: sourceRoot,
      registryUrl: "http://registry.fixture.test",
      fetchImplementation: registryFetch(registryRoot),
    });
    assert.equal(observation.receiptFound, false);
    assert.equal(observation.findings.some((f) => f.verdict === "source-missing"), false);
    assert.equal(observation.findings.find((f) => f.name === "@fixture/current-package").verdict, "current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires registryUrl", async () => {
  const { root, sourceRoot } = await fixtures();
  try {
    await assert.rejects(observeRegistryDrift({ root: sourceRoot }), /registryUrl is required/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
