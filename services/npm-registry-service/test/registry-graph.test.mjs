import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deriveRegistryGraph, groupRegistryGraphDefects, renderRegistryGraphDot } from "@red-cup-engineering/npm-registry-graph-services-section";

// The sandbox running these tests refuses TCP connections to listeners the
// test itself opens, so the HTTP face is exercised through an injected fetch
// backed by the registry server's own request resolver — the same URL and
// percent-encoding law a socket would see, minus the socket.
function registryFetch(registryDirectory) {
  return async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
    if (name === "registry-receipt.json") {
      const body = await readFile(join(registryDirectory, "registry-receipt.json"));
      return { ok: true, status: 200, arrayBuffer: async () => body };
    }
    if (!name.startsWith("@")) return { ok: false, status: 404 };
    try {
      const body = await readFile(join(registryDirectory, "metadata", `${encodeURIComponent(name)}.json`));
      return { ok: true, status: 200, arrayBuffer: async () => body };
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: false, status: 404 };
      throw error;
    }
  };
}

async function writeFixtureRegistry(root, { danglingPin = false } = {}) {
  await mkdir(join(root, "metadata"), { recursive: true });
  const manifests = {
    "@example/leaf": {
      name: "@example/leaf",
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "@example/leaf",
          version: "1.0.0",
          dist: { shasum: "leaf-sha", integrity: "sha512-leaf" },
        },
      },
    },
    "@example/stem": {
      name: "@example/stem",
      versions: {
        "2.0.0": {
          name: "@example/stem",
          version: "2.0.0",
          dependencies: { "@example/leaf": danglingPin ? "9.9.9" : "1.0.0" },
          devDependencies: { typescript: "^5.8.0" },
          redCupEngineering: { supersedes: { package: "@example/leaf", version: "1.0.0", reason: "fixture replacement" } },
          dist: { shasum: "stem-sha", integrity: "sha512-stem" },
        },
      },
    },
  };
  for (const [name, metadata] of Object.entries(manifests)) {
    await writeFile(join(root, "metadata", `${encodeURIComponent(name)}.json`), `${JSON.stringify(metadata)}\n`);
  }
  await writeFile(join(root, "registry-receipt.json"), `${JSON.stringify({
    type: "SemioticVoxelPackageRegistryReceipt",
    version: 2,
    registry: "http://registry.example.test/",
    predecessor: null,
    reaction: null,
    scopes: ["example"],
    compute: { provider: "example-test", parallelism: 1 },
    packages: [
      { name: "@example/stem", version: "2.0.0", artifact: "tarballs/example/stem/-/stem-2.0.0.tgz", bytes: 2, shasum: "stem-sha", integrity: "sha512-stem" },
      { name: "@example/leaf", version: "1.0.0", artifact: "tarballs/example/leaf/-/leaf-1.0.0.tgz", bytes: 1, shasum: "leaf-sha", integrity: "sha512-leaf" },
    ],
  })}\n`);
}

test("derives a tiered registry graph with two-leg node addresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root);
    const graph = await deriveRegistryGraph({ registryRoot: root });

    assert.equal(graph.type, "NpmRegistryGraph");
    assert.deepEqual(graph.nodes.map((node) => node.address.packageSurface), ["@example/leaf@1.0.0", "@example/stem@2.0.0"]);
    assert.equal(graph.nodes[0].address.contentIntegrity, "sha512-leaf");
    assert.match(graph.receiptSha256, /^sha256:[0-9a-f]{64}$/u);

    const internal = graph.tiers.dependency.edges.find((edge) => edge.resolution === "registry");
    assert.deepEqual(internal, {
      from: "@example/stem@2.0.0",
      to: "@example/leaf@1.0.0",
      constraint: "1.0.0",
      relation: "dependencies",
      resolution: "registry",
    });
    const external = graph.tiers.dependency.edges.find((edge) => edge.resolution === "external");
    assert.equal(external.to, "typescript");
    assert.equal(external.relation, "devDependencies");

    assert.deepEqual(graph.tiers.history, {
      predecessor: null,
      reaction: null,
      receiptVersion: 2,
      edges: [{ from: "@example/stem@2.0.0", to: "@example/leaf@1.0.0", relation: "supersedes", resolution: "registry", reason: "fixture replacement" }],
    });
    assert.equal(graph.tiers.witness.compute.provider, "example-test");
    assert.equal(graph.tiers.witness.artifacts.length, 2);
    assert.equal(graph.defects.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an unresolved internal pin as a defect, not an edge", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root, { danglingPin: true });
    const graph = await deriveRegistryGraph({ registryRoot: root });
    assert.deepEqual(graph.defects, [{
      kind: "unresolved-internal-dependency",
      from: "@example/stem@2.0.0",
      to: "@example/leaf@9.9.9",
      relation: "dependencies",
    }]);
    assert.equal(graph.tiers.dependency.edges.some((edge) => edge.to === "@example/leaf@9.9.9"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("groups repeated defects into a deterministic provider repair queue", () => {
  const groups = groupRegistryGraphDefects([
    { kind: "unresolved-internal-dependency", from: "@example/z@1.0.0", to: "@example/runtime@7.0.0", relation: "dependencies" },
    { kind: "unresolved-internal-dependency", from: "@example/a@1.0.0", to: "@example/runtime@7.0.0", relation: "dependencies" },
    { kind: "unresolved-internal-dependency", from: "@example/b@1.0.0", to: "@example/witness@1.0.0", relation: "dependencies" },
  ]);
  assert.deepEqual(groups, [
    {
      kind: "unresolved-internal-dependency",
      target: "@example/runtime@7.0.0",
      relation: "dependencies",
      count: 2,
      consumers: ["@example/a@1.0.0", "@example/z@1.0.0"],
    },
    {
      kind: "unresolved-internal-dependency",
      target: "@example/witness@1.0.0",
      relation: "dependencies",
      count: 1,
      consumers: ["@example/b@1.0.0"],
    },
  ]);
});

test("derives the same graph over the registry HTTP face as from disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root);
    const overHttp = await deriveRegistryGraph({
      registryUrl: "http://registry.example.test",
      fetchImplementation: registryFetch(root),
    });
    const fromDisk = await deriveRegistryGraph({ registryRoot: root });
    assert.deepEqual(JSON.parse(JSON.stringify(overHttp)), JSON.parse(JSON.stringify(fromDisk)));
    await assert.rejects(
      deriveRegistryGraph({ registryRoot: root, registryUrl: "http://registry.example.test" }),
      /exactly one of registryRoot/u,
    );
    await assert.rejects(deriveRegistryGraph({}), /exactly one of registryRoot/u);
    await assert.rejects(
      deriveRegistryGraph({ registryUrl: "http://registry.example.test/absent/", fetchImplementation: registryFetch(root) }),
      /registry has no build receipt/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derives a graph from an explicit package list, no receipt needed", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root);
    await rm(join(root, "registry-receipt.json"));

    const graph = await deriveRegistryGraph({
      registryUrl: "http://registry.example.test",
      fetchImplementation: registryFetch(root),
      packages: ["@example/stem@2.0.0", "@example/leaf"],
      internalScopes: ["example"],
    });
    assert.deepEqual(graph.nodes.map((node) => node.address.packageSurface), ["@example/leaf@1.0.0", "@example/stem@2.0.0"]);
    assert.equal(graph.receiptSha256, null);
    assert.deepEqual(graph.tiers.history, {
      predecessor: null,
      reaction: null,
      receiptVersion: null,
      edges: [{ from: "@example/stem@2.0.0", to: "@example/leaf@1.0.0", relation: "supersedes", resolution: "registry", reason: "fixture replacement" }],
    });
    assert.equal(graph.tiers.dependency.edges.find((edge) => edge.resolution === "registry").to, "@example/leaf@1.0.0");
    assert.equal(graph.defects.length, 0);

    const external = await deriveRegistryGraph({
      registryUrl: "http://registry.example.test",
      fetchImplementation: registryFetch(root),
      packages: [{ name: "@example/stem", version: "2.0.0" }],
    });
    assert.equal(external.tiers.dependency.edges.every((edge) => edge.resolution === "external"), true);
    assert.equal(external.defects.length, 0);

    await assert.rejects(
      deriveRegistryGraph({ registryUrl: "http://registry.example.test", fetchImplementation: registryFetch(root), packages: ["@example/stem@9.9.9"] }),
      /registry has no @example\/stem@9\.9\.9/u,
    );
    await assert.rejects(
      deriveRegistryGraph({ registryUrl: "http://registry.example.test", fetchImplementation: registryFetch(root), packages: [] }),
      /non-empty array/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renders dependency and history tiers as Graphviz DOT", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-graph-"));
  try {
    await writeFixtureRegistry(root);
    const graph = await deriveRegistryGraph({ registryRoot: root });
    const dependencyDot = renderRegistryGraphDot(graph, { tier: "dependency" });
    assert.match(dependencyDot, /"@example\/stem@2\.0\.0" -> "@example\/leaf@1\.0\.0" \[label="dependencies"\];/u);
    assert.match(dependencyDot, /"typescript" \[shape=box, style=dashed\];/u);
    const historyDot = renderRegistryGraphDot(graph, { tier: "history" });
    assert.match(historyDot, /"@example\/stem@2\.0\.0" -> "@example\/leaf@1\.0\.0" \[label="supersedes"\];/u);
    assert.throws(() => renderRegistryGraphDot(graph, { tier: "settlement" }), /unknown registry graph tier/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
