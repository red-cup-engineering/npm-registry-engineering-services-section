import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openNpmRegistry, readNpmPackument, readNpmRegistryReceipt, readNpmRegistryRelease } from "../scripts/read-npm-registry-resource.mjs";

test("reads byte-preserving registry resources and resolves the selected release", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "metadata"));
  const receiptBytes = Buffer.from('{"type":"Receipt"}\n');
  const packumentBytes = Buffer.from('{"name":"@example/a","dist-tags":{"latest":"1.0.0"},"versions":{"1.0.0":{"name":"@example/a","version":"1.0.0"}}}\n');
  await writeFile(join(root, "registry-receipt.json"), receiptBytes);
  await writeFile(join(root, "metadata", `${encodeURIComponent("@example/a")}.json`), packumentBytes);

  const registry = openNpmRegistry({ registryRoot: root });
  assert.deepEqual((await readNpmRegistryReceipt(registry)).bytes, receiptBytes);
  assert.deepEqual((await readNpmPackument(registry, "@example/a")).bytes, packumentBytes);
  const release = await readNpmRegistryRelease(registry, { name: "@example/a" });
  assert.equal(release.version, "1.0.0");
  assert.deepEqual(release.manifest, { name: "@example/a", version: "1.0.0" });
  assert.equal(await readNpmPackument(registry, "@example/missing"), null);
});

test("reads the same resources through an HTTP registry face", async () => {
  const resources = new Map([
    ["https://registry.example/registry-receipt.json", Buffer.from('{"type":"Receipt"}')],
    [`https://registry.example/${encodeURIComponent("@example/a")}`, Buffer.from('{"name":"@example/a","dist-tags":{"latest":"1.0.0"},"versions":{"1.0.0":{"name":"@example/a","version":"1.0.0"}}}')],
  ]);
  const registry = openNpmRegistry({
    registryUrl: "https://registry.example",
    fetchImplementation: async (url) => {
      const bytes = resources.get(url.href);
      return bytes === undefined
        ? { status: 404, ok: false }
        : { status: 200, ok: true, arrayBuffer: async () => bytes };
    },
  });
  assert.equal((await readNpmRegistryReceipt(registry)).value.type, "Receipt");
  assert.equal((await readNpmRegistryRelease(registry, { name: "@example/a" })).version, "1.0.0");
});

test("retries a fetch that throws (e.g. ECONNRESET) and succeeds within the bounded attempt count", async () => {
  let calls = 0;
  const registry = openNpmRegistry({
    registryUrl: "https://registry.example",
    fetchImplementation: async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("socket hang up");
        error.code = "ECONNRESET";
        throw error;
      }
      return { status: 200, ok: true, arrayBuffer: async () => Buffer.from('{"type":"Receipt"}') };
    },
  });
  const receipt = await readNpmRegistryReceipt(registry);
  assert.equal(receipt.value.type, "Receipt");
  assert.equal(calls, 3);
});

test("gives up after exhausting its bounded retry attempts and surfaces the last error", async () => {
  let calls = 0;
  const registry = openNpmRegistry({
    registryUrl: "https://registry.example",
    fetchImplementation: async () => {
      calls += 1;
      const error = new Error("socket hang up");
      error.code = "ECONNRESET";
      throw error;
    },
  });
  await assert.rejects(() => readNpmRegistryReceipt(registry), /socket hang up/);
  assert.equal(calls, 3);
});
