import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readRegistryStorageDistTag, readRegistryStorageVersions, repairStorageTarballURL } from "../src/registry.mjs";

test("local registry storage projects exact occupied versions without network probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-storage-"));
  try {
    const directory = join(root, "@example", "capability");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: "@example/capability",
      versions: { "1.0.0": {}, "1.0.2": {} },
    }));
    const versions = await readRegistryStorageVersions(root, ["@example/capability", "@example/absent"]);
    assert.deepEqual([...versions.get("@example/capability")], ["1.0.0", "1.0.2"]);
    assert.deepEqual([...versions.get("@example/absent")], []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local registry storage exposes the exact post-publication dist-tag target", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-storage-tag-"));
  try {
    const directory = join(root, "@example", "capability");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: "@example/capability", versions: { "1.1.0-dev.0": {} }, "dist-tags": { dev: "1.1.0-dev.0", latest: "1.0.0" },
    }));
    assert.deepEqual(await readRegistryStorageDistTag(root, "@example/capability", "dev"), { reachable: true, found: true, version: "1.1.0-dev.0" });
    assert.deepEqual(await readRegistryStorageDistTag(root, "@example/capability", "rc"), { reachable: true, found: true, version: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed local registry metadata is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-storage-"));
  try {
    const directory = join(root, "@example", "capability");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "wrong", versions: {} }));
    await assert.rejects(readRegistryStorageVersions(root, ["@example/capability"]), /malformed metadata/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairStorageTarballURL corrects a corrupted dist.tarball in place, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-storage-repair-"));
  try {
    const name = "@example/capability";
    const directory = join(root, "@example", "capability");
    await mkdir(directory, { recursive: true });
    const corrupted = "http://127.0.0.1:4873/@example/capability/-/@example/capability-1.0.0.tgz";
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name,
      versions: { "1.0.0": { name, version: "1.0.0", dist: { tarball: corrupted } } },
    }));
    const first = await repairStorageTarballURL(root, name, "1.0.0");
    assert.equal(first.changed, true);
    assert.equal(first.tarball, "http://127.0.0.1:4873/@example/capability/-/capability-1.0.0.tgz");
    const stored = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    assert.equal(stored.versions["1.0.0"].dist.tarball, "http://127.0.0.1:4873/@example/capability/-/capability-1.0.0.tgz");
    const second = await repairStorageTarballURL(root, name, "1.0.0");
    assert.equal(second.changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairStorageTarballURL is a no-op when the version is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-storage-repair-"));
  try {
    const name = "@example/capability";
    const directory = join(root, "@example", "capability");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, versions: {} }));
    const result = await repairStorageTarballURL(root, name, "9.9.9");
    assert.equal(result.changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
