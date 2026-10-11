import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formNodeRuntimeProviderCatalog, materializerInputsFromProviderCatalog } from "../src/runtime-provider-catalog.mjs";

async function workspacePackage(root, manifest) {
  const directory = join(root, manifest.name.replaceAll("@", "").replaceAll("/", "-"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
  return directory;
}

function artifact(manifest, file) {
  const bytes = Buffer.from(`immutable carrier for ${manifest.name}@${manifest.version}`);
  return { manifest, file, bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

function lockedArtifact(item, registry = "https://registry.example.test/npm/") {
  return {
    version: item.manifest.version,
    resolved: `${registry}${item.file}`,
    integrity: item.integrity,
    ...(item.manifest.dependencies ? { dependencies: item.manifest.dependencies } : {}),
    ...(item.manifest.optionalDependencies ? { optionalDependencies: item.manifest.optionalDependencies } : {}),
    ...(item.manifest.peerDependencies ? { peerDependencies: item.manifest.peerDependencies } : {}),
    ...(item.manifest.peerDependenciesMeta ? { peerDependenciesMeta: item.manifest.peerDependenciesMeta } : {}),
  };
}

function packageLock(manifest, records = {}) {
  return { lockfileVersion: 3, packages: { "": { name: manifest.name, version: manifest.version }, ...records } };
}

function lockReader(locks) {
  return async (entry) => ({ packageLock: locks[entry.name], path: `${entry.id}/package-lock.json` });
}

async function fakeLocalCarrierVerifier({ sourceDir }) {
  return { artifact: join(sourceDir, "package.json"), cleanup: async () => {} };
}

function registryFixture(artifacts) {
  const calls = [];
  return {
    calls,
    reader: async (registry, name, version) => {
      calls.push(`manifest:${name}@${version}`);
      const item = artifacts[`${name}@${version}`];
      return item
        ? { found: true, reachable: true, manifest: { ...item.manifest, dist: { integrity: item.integrity, tarball: `${registry}${item.file}` } } }
        : { found: false, reachable: true, manifest: null };
    },
    fetcher: async (url, options) => {
      assert.equal(options.redirect, "follow");
      calls.push(`tarball:${url.pathname.split("/").at(-1)}`);
      const item = Object.values(artifacts).find(({ file }) => url.pathname.endsWith(file));
      return item ? new Response(item.bytes) : new Response(null, { status: 404 });
    },
  };
}

test("forms a reachable mixed source and exact registry-tarball runtime catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-catalog-"));
  try {
    const workspace = join(root, "workspace");
    const app = await workspacePackage(workspace, {
      name: "@test/app", version: "1.0.0",
      dependencies: { "@test/source": "1.0.0", external: "2.0.0" },
      devDependencies: { "build-only": "9.0.0" },
    });
    const source = await workspacePackage(workspace, {
      name: "@test/source", version: "1.0.0", optionalDependencies: { optional: "^3.0.0" },
    });
    await workspacePackage(workspace, { name: "@test/unrelated", version: "1.0.0", dependencies: { never: "1.0.0" } });
    const external = artifact({ name: "external", version: "2.0.0", dependencies: { transitive: "^4.0.0", nested: "~5.1.0" } }, "external-2.0.0.tgz");
    const transitive = artifact({ name: "transitive", version: "4.0.0" }, "transitive-4.0.0.tgz");
    const nested = artifact({ name: "nested", version: "5.1.2" }, "nested-5.1.2.tgz");
    const fixture = registryFixture({ "external@2.0.0": external, "transitive@4.0.0": transitive, "nested@5.1.2": nested });
    const catalog = await formNodeRuntimeProviderCatalog({
      workspaceRoot: workspace,
      entries: [{ id: "daily", name: "@test/app" }],
      registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, "admission"),
      registryVersionReader: fixture.reader,
      fetcher: fixture.fetcher,
      localCarrierVerifier: fakeLocalCarrierVerifier,
      entryPackageLockReader: lockReader({
        "@test/app": packageLock({ name: "@test/app", version: "1.0.0" }, {
          "node_modules/@test/source": { version: "0.9.0" },
          "node_modules/external": lockedArtifact(external),
          "node_modules/external/node_modules/nested": lockedArtifact(nested),
          "node_modules/transitive": lockedArtifact(transitive),
        }),
        "@test/source": packageLock({ name: "@test/source", version: "1.0.0" }),
      }),
    });
    assert.deepEqual(catalog.entries, [{ id: "daily", name: "@test/app", version: "1.0.0" }]);
    assert.equal(catalog.entryProvider, "source");
    assert.equal(Object.hasOwn(catalog.admissions.daily, "sources"), false);
    assert.deepEqual(Object.keys(catalog.admissions.daily.nodes), ["", "node_modules/@test/source", "node_modules/external", "node_modules/external/node_modules/nested", "node_modules/transitive"]);
    assert.deepEqual(fixture.calls, [
      "manifest:external@2.0.0", "tarball:external-2.0.0.tgz",
      "manifest:nested@5.1.2", "tarball:nested-5.1.2.tgz",
      "manifest:transitive@4.0.0", "tarball:transitive-4.0.0.tgz",
    ]);
    assert.deepEqual(catalog.admissions.daily.nodes["node_modules/external"].edges, { nested: "node_modules/external/node_modules/nested", transitive: "node_modules/transitive" });
    assert.equal(catalog.admissions.daily.nodes["node_modules/@test/source"].version, "1.0.0");
    assert.equal(fixture.calls.some((call) => call.includes("build-only") || call.includes("never")), false);
    assert.deepEqual(await readFile(catalog.admissions.daily.nodes["node_modules/external"].tarballPath), external.bytes);
    assert.deepEqual(materializerInputsFromProviderCatalog(catalog), {
      entries: [{ id: "daily", nodes: catalog.admissions.daily.nodes }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forms a registry-root catalog without running a local lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-registry-root-"));
  try {
    const workspace = join(root, "workspace");
    const appManifest = {
      name: "published-app", version: "1.0.0", engines: { forge: "1.7.1" }, dependencies: { external: "2.0.0" },
    };
    await workspacePackage(workspace, appManifest);
    await workspacePackage(workspace, { name: "external", version: "2.0.0" });
    const app = artifact(appManifest, "published-app-1.0.0.tgz");
    const external = artifact({ name: "external", version: "2.0.0" }, "external-2.0.0.tgz");
    const fixture = registryFixture({ "published-app@1.0.0": app, "external@2.0.0": external });
    let localCarrierCalls = 0;
    let lifecycleObserverCalls = 0;
    const catalog = await formNodeRuntimeProviderCatalog({
      workspaceRoot: workspace,
      entries: [{ id: "published-app", name: "published-app" }],
      registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, "admission"),
      entryProvider: "registry",
      registryVersionReader: fixture.reader,
      fetcher: fixture.fetcher,
      localCarrierVerifier: async () => {
        localCarrierCalls += 1;
        throw new Error("registry-root admission must not pack local carriers");
      },
      lifecycleToolchainObserver: async () => {
        lifecycleObserverCalls += 1;
        throw new Error("registry-root admission must not inspect local lifecycle tools");
      },
      entryPackageLockReader: lockReader({
        "published-app": packageLock(appManifest, {
          "node_modules/external": lockedArtifact(external),
        }),
      }),
    });
    const entry = catalog.admissions["published-app"];
    assert.equal(localCarrierCalls, 0);
    assert.equal(lifecycleObserverCalls, 0);
    assert.deepEqual(catalog.lifecycleToolchains, {});
    assert.equal(catalog.entryProvider, "registry");
    assert.equal(entry.nodes[""].authorityKind, "registry-exact-carrier");
    assert.equal(entry.nodes[""].integrity, app.integrity);
    assert.deepEqual(await readFile(entry.nodes[""].tarballPath), app.bytes);
    assert.equal(entry.nodes[""].edges.external, "node_modules/external");
    assert.equal(entry.nodes["node_modules/external"].authorityKind, "registry-lock-carrier");
    assert.deepEqual(fixture.calls, [
      "manifest:published-app@1.0.0", "tarball:published-app-1.0.0.tgz",
      "manifest:external@2.0.0", "tarball:external-2.0.0.tgz",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry-root catalogs use npm lock placement for required and optional exact dependencies", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-registry-placement-"));
  try {
    const workspace = join(root, "workspace");
    const manifest = {
      name: "published-app", version: "1.0.0", dependencies: { installed: "2.0.0", required: "3.0.0" },
      peerDependencies: { optional: "4.0.0" }, peerDependenciesMeta: { optional: { optional: true } },
    };
    await workspacePackage(workspace, manifest);
    const app = artifact(manifest, "published-app-1.0.0.tgz");
    const installed = artifact({ name: "installed", version: "2.0.0" }, "installed-2.0.0.tgz");
    const required = artifact({ name: "required", version: "3.0.0" }, "required-3.0.0.tgz");
    const stale = artifact({ name: "required", version: "2.9.0" }, "required-2.9.0.tgz");
    const common = (records, fixture = registryFixture({ "published-app@1.0.0": app, "installed@2.0.0": installed, "required@3.0.0": required })) => ({
      workspaceRoot: workspace,
      entries: [{ id: "published-app", name: "published-app" }],
      registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, `admission-${Math.random()}`),
      entryProvider: "registry",
      registryVersionReader: fixture.reader,
      fetcher: fixture.fetcher,
      entryPackageLockReader: lockReader({ "published-app": packageLock(manifest, records) }),
    });
    await context.test("absent optional exact peer is not fetched or placed", async () => {
      const fixture = registryFixture({ "published-app@1.0.0": app, "installed@2.0.0": installed, "required@3.0.0": required });
      const catalog = await formNodeRuntimeProviderCatalog(common({ "node_modules/installed": lockedArtifact(installed), "node_modules/required": lockedArtifact(required) }, fixture));
      const nodes = catalog.admissions["published-app"].nodes;
      assert.equal(nodes["node_modules/optional"], undefined);
      assert.equal(nodes["node_modules/installed"].authorityKind, "registry-lock-carrier");
      assert.equal(nodes["node_modules/installed"].integrity, installed.integrity);
      assert.equal(fixture.calls.some((call) => call.includes("optional")), false);
    });
    await context.test("missing required exact dependency refuses before a registry fetch", async () => {
      const fixture = registryFixture({ "published-app@1.0.0": app });
      await assert.rejects(formNodeRuntimeProviderCatalog(common({}, fixture)), /lock has no selection for installed/u);
      assert.deepEqual(fixture.calls, ["manifest:published-app@1.0.0", "tarball:published-app-1.0.0.tgz"]);
    });
    await context.test("mismatched required selection refuses before its registry fetch", async () => {
      const fixture = registryFixture({ "published-app@1.0.0": app, "installed@2.0.0": installed, "required@2.9.0": stale });
      await assert.rejects(formNodeRuntimeProviderCatalog(common({
        "node_modules/installed": lockedArtifact(installed),
        "node_modules/required": lockedArtifact(stale),
      }, fixture)), /required@2\.9\.0 does not satisfy 3\.0\.0/u);
      assert.equal(fixture.calls.some((call) => call.includes("required@")), false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry-root catalogs check every lock integrity assertion for a cached provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-registry-integrity-"));
  try {
    const workspace = join(root, "workspace");
    const appManifest = { name: "published-app", version: "1.0.0", dependencies: { left: "1.0.0", right: "1.0.0" } };
    await workspacePackage(workspace, appManifest);
    const app = artifact(appManifest, "published-app-1.0.0.tgz");
    const left = artifact({ name: "left", version: "1.0.0", dependencies: { shared: "1.0.0" } }, "left-1.0.0.tgz");
    const right = artifact({ name: "right", version: "1.0.0", dependencies: { shared: "1.0.0" } }, "right-1.0.0.tgz");
    const shared = artifact({ name: "shared", version: "1.0.0" }, "shared-1.0.0.tgz");
    const conflictingShared = { ...lockedArtifact(shared), integrity: `sha512-${Buffer.alloc(64).toString("base64")}` };
    const fixture = registryFixture({ "published-app@1.0.0": app, "left@1.0.0": left, "right@1.0.0": right, "shared@1.0.0": shared });
    await assert.rejects(formNodeRuntimeProviderCatalog({
      workspaceRoot: workspace,
      entries: [{ id: "published-app", name: "published-app" }],
      registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, "admission"),
      entryProvider: "registry",
      registryVersionReader: fixture.reader,
      fetcher: fixture.fetcher,
      entryPackageLockReader: lockReader({ "published-app": packageLock(appManifest, {
        "node_modules/left": lockedArtifact(left),
        "node_modules/right": lockedArtifact(right),
        "node_modules/left/node_modules/shared": lockedArtifact(shared),
        "node_modules/right/node_modules/shared": conflictingShared,
      }) }),
    }), /registry provider shared@1\.0\.0 differs from its lock integrity evidence/u);
    assert.equal(fixture.calls.filter((call) => call === "manifest:shared@1.0.0").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admits exact lifecycle toolchains before running any local carrier lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-toolchain-"));
  try {
    const workspace = join(root, "workspace");
    await workspacePackage(workspace, { name: "forge-app", version: "1.0.0", engines: { forge: "1.7.1" } });
    const lock = packageLock({ name: "forge-app", version: "1.0.0" });
    let lifecycleCalls = 0;
    const common = {
      workspaceRoot: workspace,
      entries: [{ id: "forge-app", name: "forge-app" }],
      registry: "https://registry.example.test/npm/",
      entryPackageLockReader: lockReader({ "forge-app": lock }),
      localCarrierVerifier: async (input) => { lifecycleCalls += 1; return fakeLocalCarrierVerifier(input); },
    };
    await assert.rejects(formNodeRuntimeProviderCatalog({
      ...common,
      outputDirectory: join(root, "missing"),
      lifecycleToolchainObserver: async () => { throw new Error("not installed"); },
    }), /required lifecycle toolchain forge@1\.7\.1 is unavailable/u);
    assert.equal(lifecycleCalls, 0);
    await assert.rejects(formNodeRuntimeProviderCatalog({
      ...common,
      outputDirectory: join(root, "drift"),
      lifecycleToolchainObserver: async () => "1.8.0",
    }), /forge@1\.7\.1 differs from observed 1\.8\.0/u);
    assert.equal(lifecycleCalls, 0);
    const catalog = await formNodeRuntimeProviderCatalog({
      ...common,
      outputDirectory: join(root, "admitted"),
      lifecycleToolchainObserver: async (name) => { assert.equal(name, "forge"); return "1.7.1"; },
    });
    assert.equal(lifecycleCalls, 1);
    assert.deepEqual(catalog.lifecycleToolchains, { forge: { version: "1.7.1", observed: "1.7.1", requiredBy: "forge-app@1.0.0" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog formation refuses foreign authority, integrity drift, and stale range selections", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-catalog-refusal-"));
  try {
    const workspace = join(root, "workspace");
    await workspacePackage(workspace, { name: "app", version: "1.0.0", dependencies: { external: "2.0.0" } });
    const base = artifact({ name: "external", version: "2.0.0" }, "external.tgz");
    const admittedLock = packageLock({ name: "app", version: "1.0.0" }, { "node_modules/external": lockedArtifact(base) });
    const form = (reader, fetcher, suffix, selectedLock = admittedLock) => formNodeRuntimeProviderCatalog({
      workspaceRoot: workspace, entries: [{ id: "app", name: "app" }], registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, suffix), registryVersionReader: reader, fetcher, entryPackageLockReader: lockReader({ app: selectedLock }), localCarrierVerifier: fakeLocalCarrierVerifier,
    });
    await context.test("foreign authority", () => assert.rejects(form(
      async () => ({ found: true, reachable: true, manifest: { ...base.manifest, dist: { integrity: base.integrity, tarball: "https://foreign.example/external.tgz" } } }),
      async () => new Response(base.bytes), "foreign",
    ), /outside admitted registry authority/u));
    await context.test("integrity drift", () => assert.rejects(form(
      async () => ({ found: true, reachable: true, manifest: { ...base.manifest, dist: { integrity: base.integrity, tarball: "https://registry.example.test/npm/external.tgz" } } }),
      async () => new Response("changed"), "integrity",
    ), /integrity mismatch/u));
    await context.test("non-satisfying lock selection", async () => {
      const ranged = join(root, "ranged");
      await workspacePackage(ranged, { name: "ranged-app", version: "1.0.0", dependencies: { external: "^2.0.0" } });
      await assert.rejects(formNodeRuntimeProviderCatalog({
        workspaceRoot: ranged, entries: [{ id: "app", name: "ranged-app" }], registry: "https://registry.example.test/npm/",
        outputDirectory: join(root, "range-output"), registryVersionReader: async () => assert.fail("stale lock must fail before registry"),
        localCarrierVerifier: fakeLocalCarrierVerifier,
        entryPackageLockReader: lockReader({ "ranged-app": packageLock({ name: "ranged-app", version: "1.0.0" }, { "node_modules/external": { ...lockedArtifact(base), version: "1.0.0" } }) }),
      }), /does not satisfy \^2\.0\.0/u);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package-lock v3 is the complete per-entry external selection authority", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-lock-law-"));
  try {
    const requiredWorkspace = join(root, "required");
    const required = await workspacePackage(requiredWorkspace, { name: "required-app", version: "1.0.0", dependencies: { external: "^2.0.0" } });
    await writeFile(join(required, "package-lock.json"), `${JSON.stringify(packageLock({ name: "wrong-app", version: "1.0.0" }))}\n`);
    const common = {
      workspaceRoot: requiredWorkspace, entries: [{ id: "required", name: "required-app" }], registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, "output"), registryVersionReader: async () => assert.fail("invalid lock must refuse before registry"),
    };
    await context.test("missing required selection", () => assert.rejects(formNodeRuntimeProviderCatalog({
      ...common, entryPackageLockReader: lockReader({ "required-app": packageLock({ name: "required-app", version: "1.0.0" }) }),
      localCarrierVerifier: fakeLocalCarrierVerifier,
    }), /lock has no placement for external/u));
    await context.test("stale lock root identity", () => assert.rejects(formNodeRuntimeProviderCatalog({
      ...common,
      entryPackageLockReader: undefined,
      localCarrierVerifier: fakeLocalCarrierVerifier,
    }), /package lock root does not identify required-app@1\.0\.0/u));
    await context.test("manifest-authoritative prospective source may use a stale lock only for external placement", async () => {
      const external = artifact({ name: "external", version: "2.0.0" }, "external.tgz");
      const fixture = registryFixture({ "external@2.0.0": external });
      await writeFile(join(required, "package-lock.json"), `${JSON.stringify(packageLock({ name: "wrong-app", version: "0.9.0" }, {
        "node_modules/external": lockedArtifact(external),
      }))}\n`);
      const catalog = await formNodeRuntimeProviderCatalog({
        ...common,
        outputDirectory: join(root, "prospective-source"),
        sourceIdentityAuthority: "manifest",
        registryVersionReader: fixture.reader,
        fetcher: fixture.fetcher,
        localCarrierVerifier: fakeLocalCarrierVerifier,
        entryPackageLockReader: undefined,
      });
      assert.equal(catalog.admissions.required.nodes[""].version, "1.0.0");
      assert.equal(catalog.sourceIdentityAuthority, "manifest");
    });

    const optional = join(root, "optional");
    await workspacePackage(optional, { name: "optional-app", version: "1.0.0", optionalDependencies: { absent: "^3.0.0" } });
    const admitted = await formNodeRuntimeProviderCatalog({
      workspaceRoot: optional, entries: [{ id: "optional", name: "optional-app" }], registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, "optional-output"), registryVersionReader: async () => assert.fail("an absent optional selection must not reach registry"),
      entryPackageLockReader: lockReader({ "optional-app": packageLock({ name: "optional-app", version: "1.0.0" }) }),
      localCarrierVerifier: fakeLocalCarrierVerifier,
    });
    assert.equal(Object.values(admitted.admissions.optional.nodes).some(({ name }) => name === "absent"), false);
    assert.equal(admitted.admissions.optional.nodes[""].version, "1.0.0");

    const external = artifact({ name: "external", version: "2.0.0" }, "external.tgz");
    await context.test("foreign lock artifact authority", () => assert.rejects(formNodeRuntimeProviderCatalog({
      ...common,
      localCarrierVerifier: fakeLocalCarrierVerifier,
      entryPackageLockReader: lockReader({
        "required-app": packageLock({ name: "required-app", version: "1.0.0" }, {
          "node_modules/external": { ...lockedArtifact(external), resolved: "https://foreign.example/external.tgz" },
        }),
      }),
    }), /outside admitted registry authority/u));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install-scope entries admit development providers without making transitives development roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-install-scope-"));
  try {
    const workspace = join(root, "workspace");
    await workspacePackage(workspace, { name: "app", version: "1.0.0", devDependencies: { tool: "2.0.0" } });
    const tool = artifact({ name: "tool", version: "2.0.0", dependencies: { runtime: "3.0.0" }, devDependencies: { omitted: "9.0.0" } }, "tool.tgz");
    const runtime = artifact({ name: "runtime", version: "3.0.0" }, "runtime.tgz");
    const fixture = registryFixture({ "tool@2.0.0": tool, "runtime@3.0.0": runtime });
    const catalog = await formNodeRuntimeProviderCatalog({
      workspaceRoot: workspace,
      entries: [{ id: "app", name: "app" }],
      registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, "output"),
      entryDependencyScope: "install",
      registryVersionReader: fixture.reader,
      fetcher: fixture.fetcher,
      localCarrierVerifier: fakeLocalCarrierVerifier,
      entryPackageLockReader: lockReader({ app: packageLock({ name: "app", version: "1.0.0" }, {
        "node_modules/tool": lockedArtifact(tool),
        "node_modules/runtime": lockedArtifact(runtime),
      }) }),
    });
    assert.deepEqual(Object.keys(catalog.admissions.app.nodes), ["", "node_modules/runtime", "node_modules/tool"]);
    assert.equal(Object.values(catalog.admissions.app.nodes).some(({ name }) => name === "omitted"), false);
    assert.equal(catalog.entryDependencyScope, "install");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one entry admits two versions of one package at distinct npm locations", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-catalog-conflict-"));
  try {
    const workspace = join(root, "workspace");
    await workspacePackage(workspace, { name: "app", version: "1.0.0", dependencies: { one: "1.0.0", two: "1.0.0" } });
    const items = {
      "one@1.0.0": artifact({ name: "one", version: "1.0.0", dependencies: { shared: "1.0.0" } }, "one.tgz"),
      "two@1.0.0": artifact({ name: "two", version: "1.0.0", dependencies: { shared: "2.0.0" } }, "two.tgz"),
      "shared@1.0.0": artifact({ name: "shared", version: "1.0.0" }, "shared.tgz"),
      "shared@2.0.0": artifact({ name: "shared", version: "2.0.0" }, "shared-2.tgz"),
    };
    const fixture = registryFixture(items);
    const appLock = packageLock({ name: "app", version: "1.0.0" }, {
      "node_modules/one": lockedArtifact(items["one@1.0.0"]),
      "node_modules/two": lockedArtifact(items["two@1.0.0"]),
      "node_modules/shared": lockedArtifact(items["shared@1.0.0"]),
      "node_modules/two/node_modules/shared": lockedArtifact(artifact({ name: "shared", version: "2.0.0" }, "shared-2.tgz")),
    });
    const catalog = await formNodeRuntimeProviderCatalog({
      workspaceRoot: workspace, entries: [{ id: "app", name: "app" }], registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, "output"), registryVersionReader: fixture.reader, fetcher: fixture.fetcher,
      localCarrierVerifier: fakeLocalCarrierVerifier,
      entryPackageLockReader: lockReader({ app: appLock }),
    });
    assert.equal(catalog.admissions.app.nodes["node_modules/shared"].version, "1.0.0");
    assert.equal(catalog.admissions.app.nodes["node_modules/two/node_modules/shared"].version, "2.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent entries may lawfully select different exact provider versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-provider-catalog-independent-"));
  try {
    const workspace = join(root, "workspace");
    await workspacePackage(workspace, { name: "old-app", version: "1.0.0", dependencies: { shared: "1.0.0" } });
    await workspacePackage(workspace, { name: "new-app", version: "1.0.0", dependencies: { shared: "2.0.0" } });
    const sharedOne = artifact({ name: "shared", version: "1.0.0" }, "shared-1.tgz");
    const sharedTwo = artifact({ name: "shared", version: "2.0.0" }, "shared-2.tgz");
    const fixture = registryFixture({ "shared@1.0.0": sharedOne, "shared@2.0.0": sharedTwo });
    const catalog = await formNodeRuntimeProviderCatalog({
      workspaceRoot: workspace,
      entries: [{ id: "old", name: "old-app" }, { id: "new", name: "new-app" }],
      registry: "https://registry.example.test/npm/",
      outputDirectory: join(root, "output"),
      registryVersionReader: fixture.reader,
      fetcher: fixture.fetcher,
      localCarrierVerifier: fakeLocalCarrierVerifier,
      entryPackageLockReader: lockReader({
        "old-app": packageLock({ name: "old-app", version: "1.0.0" }, { "node_modules/shared": lockedArtifact(sharedOne) }),
        "new-app": packageLock({ name: "new-app", version: "1.0.0" }, { "node_modules/shared": lockedArtifact(sharedTwo) }),
      }),
    });
    assert.equal(catalog.admissions.old.nodes["node_modules/shared"].version, "1.0.0");
    assert.equal(catalog.admissions.new.nodes["node_modules/shared"].version, "2.0.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
