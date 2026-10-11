import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAllManifestSites, classifyPublishedPackage, findMasqueradingTags } from "../src/release-truth.mjs";

const site = (path, version, legacy = false) => Object.freeze({ path, version, legacy });

test("live-match: a live site carries the exact published version", () => {
  const result = classifyPublishedPackage({ name: "a", version: "1.0.0" }, [site("live/a/package.json", "1.0.0")]);
  assert.equal(result.category, "live-match");
});

test("version-mismatch: a live site exists but not at the published version", () => {
  const result = classifyPublishedPackage({ name: "a", version: "2.0.0" }, [site("live/a/package.json", "1.0.0")]);
  assert.equal(result.category, "version-mismatch");
});

test("legacy-only: every on-disk site is under a legacy path", () => {
  const result = classifyPublishedPackage(
    { name: "feltos", version: "0.0.2" },
    [site("lib/legacy/2026-08-04-fizzos-corpus/package.json", "0.0.2", true)],
  );
  assert.equal(result.category, "legacy-only");
});

test("legacy-only holds even when a legacy site's version doesn't match — no live site exists at all", () => {
  const result = classifyPublishedPackage(
    { name: "x", version: "1.0.0" },
    [site("lib/legacy/old/package.json", "0.9.0", true)],
  );
  assert.equal(result.category, "legacy-only");
});

test("no-disk-match: the published name has no on-disk package.json anywhere", () => {
  const result = classifyPublishedPackage({ name: "ghost", version: "1.0.0" }, undefined);
  assert.equal(result.category, "no-disk-match");
});

test("a live site wins over a coexisting legacy site of the same name", () => {
  const result = classifyPublishedPackage(
    { name: "a", version: "1.0.0" },
    [site("lib/legacy/old-a/package.json", "0.1.0", true), site("live/a/package.json", "1.0.0")],
  );
  assert.equal(result.category, "live-match");
});

test("findMasqueradingTags flags a dist-tag that resolves to a legacy-only version", () => {
  const classifications = [
    classifyPublishedPackage({ name: "feltos", version: "0.0.2" }, [site("lib/legacy/fizzos/package.json", "0.0.2", true)]),
  ];
  const distTagsByName = new Map([["feltos", { latest: "0.0.2", recovered: "0.0.2" }]]);
  const flagged = findMasqueradingTags(classifications, distTagsByName);
  assert.equal(flagged.length, 2); // both tags point at the same legacy-only version
  assert.ok(flagged.every((f) => f.name === "feltos" && f.version === "0.0.2"));
});

test("findMasqueradingTags does not flag a tag resolving to a live-match version", () => {
  const classifications = [classifyPublishedPackage({ name: "a", version: "1.0.0" }, [site("live/a/package.json", "1.0.0")])];
  const distTagsByName = new Map([["a", { latest: "1.0.0" }]]);
  assert.deepEqual(findMasqueradingTags(classifications, distTagsByName), []);
});

test("scanAllManifestSites finds both legacy and live package.json files, and skips node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-truth-"));
  try {
    await mkdir(join(root, "live", "a"), { recursive: true });
    await writeFile(join(root, "live", "a", "package.json"), JSON.stringify({ name: "@x/a", version: "1.0.0" }));
    await mkdir(join(root, "lib", "legacy", "old-a"), { recursive: true });
    await writeFile(join(root, "lib", "legacy", "old-a", "package.json"), JSON.stringify({ name: "@x/a", version: "0.1.0" }));
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(join(root, "node_modules", "ignored", "package.json"), JSON.stringify({ name: "@x/a", version: "9.9.9" }));

    const byName = await scanAllManifestSites(root);
    const sites = byName.get("@x/a");
    assert.equal(sites.length, 2);
    assert.ok(sites.some((s) => s.legacy === true && s.version === "0.1.0"));
    assert.ok(sites.some((s) => s.legacy === false && s.version === "1.0.0"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
