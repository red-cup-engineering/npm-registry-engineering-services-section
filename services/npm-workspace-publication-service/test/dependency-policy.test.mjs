import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dependencyContractViolations,
  dependencySpecificationViolations,
  isExactSemver,
  packageLockDirectResolutionViolations,
  packageLockExactResolutionClosureViolations,
  packageLockRegistryCarrierViolations,
  packageLockRootDependencyViolations,
  packageLockRootIdentityViolations,
} from "../src/dependency-policy.mjs";

test("only one exact semver is admitted", () => {
  assert.equal(isExactSemver("1.2.3"), true);
  assert.equal(isExactSemver("1.2.3-beta.1+build.4"), true);
  for (const value of ["workspace:*", "file:../a", "link:../a", "^1.2.3", "~1.2.3", ">=1", "latest", "github:a/b"]) {
    assert.equal(isExactSemver(value), false, value);
  }
});

test("stable packages cannot pin prerelease dependencies while prerelease consumers can", () => {
  assert.deepEqual(dependencySpecificationViolations({ version: "1.0.0", dependencies: { provider: "2.0.0-dev.0" } }), [{
    field: "dependencies", name: "provider", specification: "2.0.0-dev.0", reason: "a stable package must not depend on a prerelease package",
  }]);
  assert.deepEqual(dependencySpecificationViolations({ version: "1.0.0-dev.0", dependencies: { provider: "2.0.0-dev.0" } }), []);
});

test("a lock root cannot conceal a stale direct resolution", () => {
  const manifest = {
    dependencies: { "@scope/provider": "1.2.3" },
    devDependencies: { tool: "4.5.6" },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@scope/provider": "1.2.3" }, devDependencies: { tool: "4.5.6" } },
      "node_modules/@scope/provider": { version: "1.2.2" },
    },
  };
  assert.deepEqual(packageLockRootDependencyViolations(manifest, lock), []);
  assert.deepEqual(packageLockDirectResolutionViolations(manifest, lock), [
    {
      field: "dependencies",
      name: "@scope/provider",
      manifestSpecification: "1.2.3",
      resolvedVersion: "1.2.2",
      reason: "package-lock direct resolution must equal package.json",
    },
    {
      field: "devDependencies",
      name: "tool",
      manifestSpecification: "4.5.6",
      resolvedVersion: undefined,
      reason: "package-lock graph has no direct resolution for the exact dependency",
    },
  ]);
});

test("every exact direct dependency field resolves to its declared version", () => {
  const manifest = {
    dependencies: { runtime: "1.0.0" },
    devDependencies: { development: "2.0.0" },
    optionalDependencies: { optional: "3.0.0" },
    peerDependencies: { peer: "4.0.0" },
  };
  const lock = { lockfileVersion: 3, packages: Object.fromEntries([
    ["", manifest],
    ...Object.entries({ runtime: "1.0.0", development: "2.0.0", optional: "3.0.0", peer: "4.0.0" })
      .map(([name, version]) => [`node_modules/${name}`, { version }]),
  ]) };
  assert.deepEqual(packageLockDirectResolutionViolations(manifest, lock), []);
});

test("an explicitly optional peer may remain unresolved", () => {
  const manifest = {
    peerDependencies: { adapter: "1.0.0" },
    peerDependenciesMeta: { adapter: { optional: true } },
  };
  assert.deepEqual(packageLockDirectResolutionViolations(manifest, { lockfileVersion: 3, packages: { "": manifest } }), []);
});

test("a semantic contract names required runtime dependencies without duplicating their versions", () => {
  const manifest = { name: "consumer", version: "1.0.0", dependencies: { provider: "1.2.3" } };
  const lock = { lockfileVersion: 3, packages: {
    "": { name: "consumer", version: "1.0.0", dependencies: { provider: "1.2.3" } },
    "node_modules/provider": { version: "1.2.3" },
  } };
  assert.deepEqual(dependencyContractViolations(manifest, lock, { requiredDependencies: ["provider"] }), []);
  assert.deepEqual(dependencyContractViolations(manifest, lock, { requiredDependencies: ["missing", "missing"] }).at(-1), {
    field: "dependencies",
    name: "missing",
    specification: undefined,
    reason: "semantically required runtime dependency is absent",
  });
  assert.throws(() => dependencyContractViolations(manifest, lock, { requiredDependencies: [null] }), /requiredDependencies/u);
});

test("exact lock closure follows nested and hoisted Node resolution", () => {
  const lock = { lockfileVersion: 3, packages: {
    "": { dependencies: { a: "1.0.0" } },
    "node_modules/a": { version: "1.0.0", dependencies: { nested: "2.0.0", hoisted: "3.0.0" }, optionalDependencies: { optional: "4.0.0" }, peerDependencies: { peer: "5.0.0" } },
    "node_modules/a/node_modules/nested": { version: "2.0.0" },
    "node_modules/hoisted": { version: "3.0.0" },
    "node_modules/optional": { version: "4.0.0" },
    "node_modules/peer": { version: "5.0.0" },
  } };
  assert.deepEqual(packageLockExactResolutionClosureViolations(lock), []);
});

test("exact lock closure reports every missing and wrong nested selection", () => {
  const lock = { lockfileVersion: 3, packages: {
    "": { dependencies: { a: "1.0.0" } },
    "node_modules/a": { version: "1.0.0", dependencies: { wrong: "2.0.0", missing: "3.0.0" } },
    "node_modules/wrong": { version: "1.9.0" },
  } };
  assert.deepEqual(packageLockExactResolutionClosureViolations(lock).map(({ location, name, specification, resolvedLocation, resolvedVersion }) => ({ location, name, specification, resolvedLocation, resolvedVersion })), [
    { location: "node_modules/a", name: "wrong", specification: "2.0.0", resolvedLocation: "node_modules/wrong", resolvedVersion: "1.9.0" },
    { location: "node_modules/a", name: "missing", specification: "3.0.0", resolvedLocation: null, resolvedVersion: undefined },
  ]);
});

test("workspace links dereference their root-relative target identity and version", () => {
  const manifest = { dependencies: { "@scope/provider": "2.0.0" } };
  const packages = {
    "": { dependencies: { "@scope/provider": "2.0.0" } },
    "node_modules/@scope/provider": { resolved: "packages/provider", link: true },
    "packages/provider": { name: "@scope/provider", version: "2.0.0" },
  };
  assert.deepEqual(packageLockDirectResolutionViolations(manifest, { lockfileVersion: 3, packages }), []);
  assert.deepEqual(packageLockExactResolutionClosureViolations({ lockfileVersion: 3, packages }), []);
  assert.equal(packageLockRegistryCarrierViolations({ lockfileVersion: 3, packages }).length, 1);
  packages["packages/provider"].version = "1.9.0";
  assert.equal(packageLockDirectResolutionViolations(manifest, { lockfileVersion: 3, packages })[0].resolvedVersion, "1.9.0");
});

test("linked targets resolve only through their physical filesystem ancestors", () => {
  const base = {
    "": { dependencies: { plugin: "1.0.0", hoisted: "2.0.0" } },
    "node_modules/plugin": { resolved: "packages/plugin", link: true },
    "packages/plugin": { name: "plugin", version: "1.0.0", dependencies: { hoisted: "2.0.0" } },
    "node_modules/hoisted": { version: "2.0.0" },
  };
  assert.deepEqual(packageLockExactResolutionClosureViolations({ lockfileVersion: 3, packages: base }), []);
  const external = structuredClone(base);
  external["node_modules/plugin"].resolved = "../plugin";
  external["../plugin"] = external["packages/plugin"];
  delete external["packages/plugin"];
  assert.equal(packageLockExactResolutionClosureViolations({ lockfileVersion: 3, packages: external })[0].name, "hoisted");
});

test("missing optional and peer-optional edges are valid while a local peer is not", () => {
  const absent = { lockfileVersion: 3, packages: {
    "": { dependencies: { plugin: "1.0.0" } },
    "node_modules/plugin": {
      version: "1.0.0",
      optionalDependencies: { adapter: "2.0.0" },
      peerDependencies: { peer: "3.0.0" },
      peerDependenciesMeta: { peer: { optional: true } },
    },
  } };
  assert.deepEqual(packageLockExactResolutionClosureViolations(absent), []);
  absent.packages["node_modules/plugin"].peerDependenciesMeta = {};
  absent.packages["node_modules/plugin/node_modules/peer"] = { version: "3.0.0" };
  assert.equal(packageLockExactResolutionClosureViolations(absent)[0].reason, "peer dependency must resolve beside or above its dependent");
});

test("npm field precedence is peer then production then optional", () => {
  const lock = { lockfileVersion: 3, packages: {
    "": { dependencies: { plugin: "1.0.0" } },
    "node_modules/plugin": {
      version: "1.0.0",
      peerDependencies: { shared: "1.0.0" },
      dependencies: { shared: "2.0.0" },
      optionalDependencies: { shared: "3.0.0" },
    },
    "node_modules/shared": { version: "3.0.0" },
  } };
  assert.deepEqual(packageLockExactResolutionClosureViolations(lock), []);
});

test("root development edges have npm's final precedence", () => {
  const lock = { lockfileVersion: 3, packages: {
    "": { dependencies: { shared: "1.0.0" }, devDependencies: { shared: "2.0.0" } },
    "node_modules/shared": { version: "2.0.0" },
  } };
  assert.deepEqual(packageLockExactResolutionClosureViolations(lock), []);
});

test("a malformed selected link is invalid even when its edge is optional", () => {
  const lock = { lockfileVersion: 3, packages: {
    "": { optionalDependencies: { adapter: "1.0.0" } },
    "node_modules/adapter": { link: true, resolved: "packages/absent" },
  } };
  assert.equal(packageLockExactResolutionClosureViolations(lock)[0].reason, "package-lock link target is absent");
});

test("only reachable extraneous records violate the closure", () => {
  const lock = { lockfileVersion: 3, packages: {
    "": { dependencies: { used: "1.0.0" } },
    "node_modules/used": { version: "1.0.0", extraneous: true },
    "node_modules/disconnected": { version: "9.9.9", extraneous: true, dependencies: { missing: "1.0.0" } },
  } };
  const violations = packageLockExactResolutionClosureViolations(lock);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].resolvedLocation, "node_modules/used");
  assert.equal(violations[0].reason, "reachable package-lock entry must not be extraneous");
});

test("every dependency field follows the same rule", () => {
  const violations = dependencySpecificationViolations({
    dependencies: { a: "1.0.0", b: "workspace:*" },
    devDependencies: { c: "^2.0.0" },
    optionalDependencies: { d: "file:../d" },
    peerDependencies: { e: "latest" },
  });
  // A source manifest may name a workspace sibling as workspace:*; every other non-exact form is a violation.
  assert.deepEqual(violations.map(({ field, name }) => `${field}.${name}`), [
    "devDependencies.c",
    "optionalDependencies.d",
    "peerDependencies.e",
  ]);
});

test("a published manifest names exact versions only, workspace:* included", () => {
  const violations = dependencySpecificationViolations({ dependencies: { a: "1.0.0", b: "workspace:*" } }, { published: true });
  assert.deepEqual(violations.map(({ field, name }) => `${field}.${name}`), ["dependencies.b"]);
});

test("a package-level workspaces declaration is refused", () => {
  assert.equal(dependencySpecificationViolations({ workspaces: ["packages/*"] })[0].field, "workspaces");
});

test("dependency overrides are refused instead of silently rewriting a provider contract", () => {
  const violations = dependencySpecificationViolations({ dependencies: { a: "2.0.0" }, overrides: { a: "1.0.0" } });
  assert.equal(violations[0].field, "overrides");
});

test("a package lock root must repeat the manifest's direct dependency contract", () => {
  const violations = packageLockRootDependencyViolations(
    { dependencies: { a: "1.0.0" }, devDependencies: { b: "2.0.0" } },
    { packages: { "": { dependencies: { a: "0.9.0", stale: "3.0.0" }, devDependencies: { b: "2.0.0" } } } },
  );
  assert.deepEqual(violations.map(({ field, name, manifestSpecification, lockSpecification }) => ({
    field,
    name,
    manifestSpecification,
    lockSpecification,
  })), [
    { field: "dependencies", name: "a", manifestSpecification: "1.0.0", lockSpecification: "0.9.0" },
    { field: "dependencies", name: "stale", manifestSpecification: undefined, lockSpecification: "3.0.0" },
  ]);
});

test("a package lock root must carry the manifest's own identity", () => {
  assert.deepEqual(packageLockRootIdentityViolations(
    { name: "current", version: "2.0.0" },
    { packages: { "": { name: "former", version: "1.0.0" } } },
  ), [
    { field: "name", manifestValue: "current", lockValue: "former", reason: "package-lock root name must equal package.json" },
    { field: "version", manifestValue: "2.0.0", lockValue: "1.0.0", reason: "package-lock root version must equal package.json" },
  ]);
});
