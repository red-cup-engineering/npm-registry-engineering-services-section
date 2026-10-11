import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyExactDependencyPinPlan,
  isNonRegistrySpecifier,
  pinExactDependencies,
  planExactDependencyPins,
  registryForPackageName,
} from "../src/pin-exact-dependencies.mjs";

function fakeRegistry(byName) {
  return async (registry, name) => {
    const entry = byName[name];
    if (!entry) return { found: false, reachable: true, packument: null };
    return { found: true, reachable: true, packument: { name, versions: Object.fromEntries(entry.versions.map((v) => [v, {}])) } };
  };
}

test("registryForPackageName routes house scopes to the canonical registry, everything else to npmjs", () => {
  assert.equal(registryForPackageName("@red-cup-engineering/foo"), "https://registry.561.group/");
  assert.equal(registryForPackageName("@emsenn/bar"), "https://registry.561.group/");
  assert.equal(registryForPackageName("@some-other-scope/baz"), "https://registry.npmjs.org/");
  assert.equal(registryForPackageName("acorn"), "https://registry.npmjs.org/");
});

test("isNonRegistrySpecifier recognizes workspace/file/link/git/URL specs only", () => {
  for (const spec of ["workspace:*", "file:../a", "link:../a", "git+https://x/y.git", "git://x/y.git", "github:a/b", "https://example.test/a.tgz", "http://example.test/a.tgz"]) {
    assert.equal(isNonRegistrySpecifier(spec), true, spec);
  }
  for (const spec of ["1.2.3", "^1.2.3", "*", "latest"]) {
    assert.equal(isNonRegistrySpecifier(spec), false, spec);
  }
});

test("plans a lockfile-sourced pin when the package's own lock resolves the dependency", async () => {
  const manifest = { name: "@test/pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } };
  const packageLock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { dep: "^1.0.0" } },
      "node_modules/dep": { version: "1.4.2" },
    },
  };
  const plan = await planExactDependencyPins(manifest, { packageLock });
  assert.deepEqual(plan.rewrites, [{ field: "dependencies", name: "dep", from: "^1.0.0", to: "1.4.2", source: "lockfile" }]);
  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(plan.removeFields, []);
});

test("plans a registry-sourced pin (highest satisfying published version) when no lock resolves the entry", async () => {
  const manifest = { name: "@test/pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } };
  const readRegistryPackageImpl = fakeRegistry({ dep: { versions: ["0.9.0", "1.0.0", "1.2.0", "2.0.0"] } });
  const plan = await planExactDependencyPins(manifest, { packageLock: null, readRegistryPackageImpl });
  assert.deepEqual(plan.rewrites, [{ field: "dependencies", name: "dep", from: "^1.0.0", to: "1.2.0", source: "registry:https://registry.npmjs.org/" }]);
  assert.deepEqual(plan.refusals, []);
});

test("registry-sourced pin uses the house registry for a house scope", async () => {
  const manifest = { name: "@test/pkg", version: "1.0.0", dependencies: { "@red-cup-engineering/dep": "^1.0.0" } };
  const readRegistryPackageImpl = fakeRegistry({ "@red-cup-engineering/dep": { versions: ["1.0.0", "1.1.0"] } });
  const plan = await planExactDependencyPins(manifest, { packageLock: null, readRegistryPackageImpl });
  assert.deepEqual(plan.rewrites, [{ field: "dependencies", name: "@red-cup-engineering/dep", from: "^1.0.0", to: "1.1.0", source: "registry:https://registry.561.group/" }]);
});

test("refuses workspace/file/link/git/URL specifiers without ever contacting the registry", async () => {
  const manifest = {
    name: "@test/pkg",
    version: "1.0.0",
    dependencies: { a: "workspace:*", b: "file:../b", c: "link:../c", d: "git+https://x/y.git", e: "https://example.test/e.tgz" },
  };
  let called = false;
  const readRegistryPackageImpl = async () => { called = true; return { found: false, reachable: true, packument: null }; };
  const plan = await planExactDependencyPins(manifest, { packageLock: null, readRegistryPackageImpl });
  assert.equal(plan.rewrites.length, 0);
  assert.equal(plan.refusals.length, 5);
  assert.equal(called, false);
  for (const refusal of plan.refusals) assert.match(refusal.reason, /non-registry specifier/);
});

test("refuses a dependency absent from the registry and one whose range no published version satisfies", async () => {
  const manifest = { name: "@test/pkg", version: "1.0.0", dependencies: { missing: "^1.0.0", "too-new": "^9.0.0" } };
  const readRegistryPackageImpl = fakeRegistry({ "too-new": { versions: ["1.0.0", "2.0.0"] } });
  const plan = await planExactDependencyPins(manifest, { packageLock: null, readRegistryPackageImpl });
  assert.deepEqual(plan.rewrites, []);
  const byName = Object.fromEntries(plan.refusals.map((r) => [r.name, r.reason]));
  assert.match(byName.missing, /not found on registry/);
  assert.match(byName["too-new"], /no version published .* satisfies the range/);
});

test("refuses a non-semver-range specification such as a dist-tag", async () => {
  const manifest = { name: "@test/pkg", version: "1.0.0", dependencies: { dep: "latest" } };
  const plan = await planExactDependencyPins(manifest, { packageLock: null, readRegistryPackageImpl: fakeRegistry({}) });
  assert.equal(plan.refusals.length, 1);
  assert.match(plan.refusals[0].reason, /not a resolvable semver range/);
});

test("plans removal of workspaces and overrides fields, and applyExactDependencyPinPlan preserves untouched key order", () => {
  const manifest = { name: "@test/pkg", version: "1.0.0", workspaces: ["packages/*"], overrides: { dep: "1.0.0" }, dependencies: { dep: "^1.0.0" }, license: "MIT" };
  const plan = { rewrites: [{ field: "dependencies", name: "dep", to: "1.4.2" }], removeFields: ["workspaces", "overrides"] };
  const next = applyExactDependencyPinPlan(manifest, plan);
  assert.deepEqual(Object.keys(next), ["name", "version", "dependencies", "license"]);
  assert.equal(next.dependencies.dep, "1.4.2");
  assert.equal(Object.hasOwn(next, "workspaces"), false);
  assert.equal(Object.hasOwn(next, "overrides"), false);
  assert.deepEqual(manifest.dependencies, { dep: "^1.0.0" }, "the input manifest is not mutated");
});

async function fixture(root) {
  const dir = join(root, "pkg");
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "package.json");
  const manifest = { name: "@test/pkg", version: "1.0.0", workspaces: ["packages/*"], dependencies: { dep: "^1.0.0" } };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "package-lock.json"), `${JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { dependencies: { dep: "^1.0.0" } }, "node_modules/dep": { version: "1.4.2" } },
  }, null, 2)}\n`, "utf8");
  return { path: manifestPath, dir, manifest };
}

test("--plan mode reports the rewrite plan and never touches the manifest on disk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pin-exact-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = await fixture(root);
  const before = await readFile(site.path, "utf8");

  const report = await pinExactDependencies({ sites: [site], apply: false });

  assert.equal(report.kind, "npm-workspace-publication.exact-pin-repair");
  assert.equal(report.ok, true);
  assert.equal(report.packages.length, 1);
  assert.deepEqual(report.packages[0].rewrites, [{ field: "dependencies", name: "dep", from: "^1.0.0", to: "1.4.2", source: "lockfile" }]);
  assert.equal(report.packages[0].violationsAfter, 0, "plan mode simulates the rewrite to report what would remain");
  assert.equal(await readFile(site.path, "utf8"), before, "plan mode changes nothing on disk");
});

test("--apply mode writes the rewritten manifest and gates on zero remaining violations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pin-exact-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = await fixture(root);

  const report = await pinExactDependencies({ sites: [site], apply: true });

  assert.equal(report.ok, true);
  assert.equal(report.packages[0].violationsAfter, 0);
  const written = JSON.parse(await readFile(site.path, "utf8"));
  const writtenLock = JSON.parse(await readFile(join(site.dir, "package-lock.json"), "utf8"));
  assert.equal(written.dependencies.dep, "1.4.2");
  assert.equal(writtenLock.packages[""].dependencies.dep, "1.4.2");
  assert.equal(Object.hasOwn(written, "workspaces"), false);
  assert.deepEqual(Object.keys(written), ["name", "version", "dependencies"]);
});

test("--apply mode repairs a stale lock root even when the manifest is already exact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pin-exact-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = await fixture(root);
  const manifest = { name: "@test/pkg", version: "1.0.0", dependencies: { dep: "1.4.2" } };
  await writeFile(site.path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  site.manifest = manifest;

  const report = await pinExactDependencies({ sites: [site], apply: true });

  assert.equal(report.ok, true);
  assert.deepEqual(report.packages[0].rewrites, []);
  assert.deepEqual(report.packages[0].lockRootRewrites.map(({ field, name, manifestSpecification, lockSpecification }) => ({
    field, name, manifestSpecification, lockSpecification,
  })), [{ field: "dependencies", name: "dep", manifestSpecification: "1.4.2", lockSpecification: "^1.0.0" }]);
  const writtenLock = JSON.parse(await readFile(join(site.dir, "package-lock.json"), "utf8"));
  assert.equal(writtenLock.packages[""].dependencies.dep, "1.4.2");
  assert.equal(writtenLock.packages["node_modules/dep"].version, "1.4.2");
});

test("--apply mode leaves already-synchronized manifest and lock bytes untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pin-exact-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = await fixture(root);
  const manifest = { name: "@test/pkg", version: "1.0.0", dependencies: { dep: "1.4.2" } };
  const lock = {
    lockfileVersion: 3,
    packages: { "": { dependencies: { dep: "1.4.2" } }, "node_modules/dep": { version: "1.4.2" } },
  };
  await writeFile(site.path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(site.dir, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  site.manifest = manifest;
  const manifestBefore = await readFile(site.path, "utf8");
  const lockBefore = await readFile(join(site.dir, "package-lock.json"), "utf8");

  const report = await pinExactDependencies({ sites: [site], apply: true });

  assert.equal(report.ok, true);
  assert.deepEqual(report.packages[0].rewrites, []);
  assert.deepEqual(report.packages[0].lockRootRewrites, []);
  assert.equal(await readFile(site.path, "utf8"), manifestBefore);
  assert.equal(await readFile(join(site.dir, "package-lock.json"), "utf8"), lockBefore);
});

test("--apply mode fails the gate (ok: false) when a refusal leaves a real violation behind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pin-exact-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "pkg");
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, "package.json");
  const manifest = { name: "@test/pkg", version: "1.0.0", dependencies: { dep: "workspace:*" } };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const report = await pinExactDependencies({ sites: [{ path: manifestPath, dir, manifest }], apply: true });

  assert.equal(report.ok, false);
  assert.equal(report.packages[0].violationsAfter, 1);
  assert.equal(report.packages[0].refusals.length, 1);
  const written = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(written.dependencies.dep, "workspace:*", "an unresolved refusal is left exactly as written, never guessed at");
});
