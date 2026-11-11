import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverPackages, loadIgnoreDirectoryNames } from "../src/discover-npm-packages.mjs";

async function manifest(path, body) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), `${JSON.stringify(body)}\n`);
}

test("finds nested scoped exact-version packages and reports what it declined, with reasons", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-tree-discovery-"));
  try {
    await manifest(join(root, "services", "alpha"), { name: "@customer/alpha", version: "1.0.0", private: false });
    await manifest(join(root, "services", "alpha", "services", "beta"), { name: "@customer/beta", version: "0.0.1", private: false });
    await manifest(join(root, "services", "unversioned"), { name: "@customer/unversioned" });
    await manifest(join(root, "services", "range-version"), { name: "@customer/range-version", version: "^1.0.0" });
    await manifest(join(root, "services", "unscoped"), { name: "unscoped" });
    await manifest(join(root, "services", "reserved"), { name: "@emsenn/internal", version: "1.0.0" });
    await mkdir(join(root, "services", "node_modules", "noise"), { recursive: true });
    await writeFile(join(root, "services", "node_modules", "noise", "package.json"), `${JSON.stringify({ name: "@customer/noise", version: "1.0.0" })}\n`);
    await manifest(join(root, "services", "content", "assets", "legacy", "old"), { name: "@customer/old", version: "1.0.0" });
    await mkdir(join(root, "services", "broken"), { recursive: true });
    await writeFile(join(root, "services", "broken", "package.json"), "not json");

    const report = await discoverPackages({ root });

    assert.equal(report.type, "NpmPackageTreeDiscoveryReport");
    assert.deepEqual(report.found.map((row) => row.name).sort(), ["@customer/alpha", "@customer/beta"]);
    const reasons = Object.fromEntries(report.skipped.map((row) => [row.directory.split("/").at(-1), row.reason]));
    assert.equal(reasons.unversioned, "version-not-exact");
    assert.equal(reasons["range-version"], "version-not-exact");
    assert.equal(reasons.unscoped, "name-not-scoped-sovereign");
    assert.equal(reasons.reserved, "reserved-scope");
    assert.ok(report.skipped.some((row) => row.reason.startsWith("ignored-directory-name:node_modules")));
    // "legacy" is caught by the default ignored-directory-name list before the
    // path-segment check ever runs — the dedicated segment test below (with a
    // legacy-free segment) proves the segment check independently.
    assert.ok(report.skipped.some((row) => row.reason.startsWith("ignored-directory-name:legacy")));
    assert.ok(report.skipped.some((row) => row.reason === "unreadable-or-invalid-package-json"));
    assert.equal(report.collisions.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a name@version collision across two different directories rather than silently picking one", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-tree-discovery-collision-"));
  try {
    await manifest(join(root, "one"), { name: "@customer/dup", version: "1.0.0", private: false });
    await manifest(join(root, "two"), { name: "@customer/dup", version: "1.0.0", private: false });
    const report = await discoverPackages({ root });
    assert.equal(report.found.length, 2);
    assert.equal(report.collisions.length, 1);
    assert.equal(report.collisions[0].identity, "@customer/dup@1.0.0");
    assert.equal(report.collisions[0].directories.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never walks into a registry's own prior output territory", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-tree-discovery-registry-output-"));
  try {
    await manifest(join(root, "data", "package-registry-v2", "tarballs", "unpacked"), { name: "@customer/packed", version: "1.0.0", private: false });
    await manifest(join(root, "services", "real"), { name: "@customer/real", version: "1.0.0", private: false });
    const report = await discoverPackages({ root });
    assert.deepEqual(report.found.map((row) => row.name), ["@customer/real"]);
    assert.ok(report.skipped.some((row) => row.reason === "registry-output-territory"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never walks into a Claude Code git-worktree checkout, which duplicates whatever it was cut from", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-tree-discovery-worktree-"));
  try {
    await manifest(join(root, "services", "real"), { name: "@customer/real", version: "1.0.0", private: false });
    await manifest(join(root, ".claude", "worktrees", "some-branch", "services", "real"), { name: "@customer/real", version: "1.0.0", private: false });
    const report = await discoverPackages({ root });
    assert.equal(report.found.length, 1);
    assert.equal(report.collisions.length, 0);
    assert.ok(report.skipped.some((row) => row.reason.startsWith("ignored-path-segment:/.claude/worktrees/")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("honours an extra ignored directory name and an extra ignored path segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-tree-discovery-ignore-"));
  try {
    await manifest(join(root, "quarantine", "inner"), { name: "@customer/quarantined", version: "1.0.0", private: false });
    await manifest(join(root, "staging", "segmented", "inner"), { name: "@customer/segmented", version: "1.0.0", private: false });
    await manifest(join(root, "services", "real"), { name: "@customer/real", version: "1.0.0", private: false });
    const report = await discoverPackages({
      root,
      ignoreDirectoryNames: ["quarantine"],
      ignorePathSegments: ["/staging/segmented/"],
    });
    assert.deepEqual(report.found.map((row) => row.name), ["@customer/real"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads bare directory-name patterns from a house .rgignore-style file, ignoring segment/glob lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-tree-discovery-ignorefile-"));
  try {
    const ignoreFile = join(root, ".rgignore");
    await writeFile(ignoreFile, "# comment\nquarantine/\nnode_modules/\ndata/package-registry*/\n");
    const names = await loadIgnoreDirectoryNames(ignoreFile);
    assert.deepEqual(names, ["quarantine", "node_modules"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a root that is not a non-empty string", async () => {
  await assert.rejects(() => discoverPackages({ root: "" }), TypeError);
  await assert.rejects(() => discoverPackages({}), TypeError);
});
