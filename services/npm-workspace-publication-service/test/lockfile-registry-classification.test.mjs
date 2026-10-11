import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyLockfileResolvedUrls } from "../src/lockfile-registry-classification.mjs";

const CANONICAL = "https://registry.561.group";

test("every resolution at the canonical registry counts as canonical, none stray", () => {
  const lock = {
    packages: {
      "": { name: "root" },
      "node_modules/semver": { resolved: "https://registry.561.group/semver/-/semver-7.7.2.tgz" },
      "node_modules/@red-cup-engineering/acorn-like": { resolved: "https://registry.561.group/@red-cup-engineering/acorn-like/-/acorn-like-1.0.0.tgz" },
    },
  };
  const result = classifyLockfileResolvedUrls(lock, CANONICAL);
  assert.equal(result.resolvedTotal, 2);
  assert.equal(result.canonical, 2);
  assert.equal(result.notCanonicalRegistry, 0);
  assert.equal(result.houseScopedNotCanonical, 0);
});

test("a public dependency off-canonical is counted but not house-scoped", () => {
  const lock = {
    packages: {
      "": { name: "root" },
      "node_modules/sharp": { resolved: "https://registry.npmjs.org/sharp/-/sharp-0.33.0.tgz" },
    },
  };
  const result = classifyLockfileResolvedUrls(lock, CANONICAL);
  assert.equal(result.notCanonicalRegistry, 1);
  assert.equal(result.houseScopedNotCanonical, 0);
});

test("a house-scoped dependency off-canonical is flagged by name and location", () => {
  const lock = {
    packages: {
      "": { name: "root" },
      "node_modules/@red-cup-engineering/eavt-services-section": { resolved: "http://127.0.0.1:4873/@red-cup-engineering/eavt-services-section/-/eavt-0.5.0.tgz" },
    },
  };
  const result = classifyLockfileResolvedUrls(lock, CANONICAL);
  assert.equal(result.houseScopedNotCanonical, 1);
  assert.deepEqual(result.houseScopedNotCanonicalEntries[0].name, "@red-cup-engineering/eavt-services-section");
});

test("a package's own resolved field takes precedence over the location-derived name", () => {
  const lock = {
    packages: {
      "": { name: "root" },
      "node_modules/aliased": { name: "@red-cup-engineering/metrologic", resolved: "http://127.0.0.1:4873/@red-cup-engineering/metrologic/-/metrologic-1.0.0.tgz" },
    },
  };
  const result = classifyLockfileResolvedUrls(lock, CANONICAL);
  assert.equal(result.houseScopedNotCanonical, 1);
});

test("the root package entry (location \"\") is never counted", () => {
  const lock = { packages: { "": { name: "root", resolved: "should-be-ignored" } } };
  assert.equal(classifyLockfileResolvedUrls(lock, CANONICAL).resolvedTotal, 0);
});

test("throws on a non-object lockfile or an empty registry", () => {
  assert.throws(() => classifyLockfileResolvedUrls(null, CANONICAL), TypeError);
  assert.throws(() => classifyLockfileResolvedUrls({}, ""), TypeError);
});
