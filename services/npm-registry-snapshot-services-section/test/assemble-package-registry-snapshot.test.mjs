import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assemblePackageRegistrySnapshot } from "../scripts/assemble-package-registry-snapshot.mjs";

async function release(root, name, version, manifest = {}) {
  const artifactPath = join(root, `${name.slice(name.indexOf("/") + 1)}-${version}.tgz`);
  const bytes = Buffer.from(`artifact ${name}@${version}\n`);
  await writeFile(artifactPath, bytes);
  return { artifactPath, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, manifest: { name, version, ...manifest } };
}

test("assembles canonical metadata, receipt, client configuration, and deterministic latest tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-snapshot-assembly-"));
  try {
    const packageInterfaces = {
      exports: { ".": "./src/index.mjs" },
      imports: { "#support": "./src/support.mjs" },
      bin: { example: "./scripts/example.mjs" },
      scripts: { check: "node --test" },
      engines: { node: ">=24" },
      os: ["linux"],
      cpu: ["x64"],
    };
    const receipt = await assemblePackageRegistrySnapshot({
      releases: [await release(root, "@customer/example", "1.0.1", packageInterfaces), await release(root, "@customer/example", "1.0.0"), await release(root, "plain", "2.0.0")],
      outputDirectory: join(root, "registry"), registryUrl: "http://127.0.0.1:4873/",
      compute: { provider: "urn:test", parallelism: 1, settlement: { type: "test" } },
    });
    assert.deepEqual(receipt.scopes, ["customer"]);
    assert.equal(receipt.packageCount, 2);
    assert.equal(receipt.packages[0].artifact, "tarballs/customer/example/-/example-1.0.0.tgz");
    const metadata = JSON.parse(await readFile(join(root, "registry", "metadata", "%40customer%2Fexample.json"), "utf8"));
    assert.equal(metadata["dist-tags"].latest, "1.0.1");
    assert.equal(metadata.versions["1.0.1"].dist.tarball, "http://127.0.0.1:4873/tarballs/customer/example/-/example-1.0.1.tgz");
    for (const key of ["exports", "imports", "bin", "scripts", "engines", "os", "cpu"]) {
      assert.deepEqual(metadata.versions["1.0.1"][key], packageInterfaces[key]);
    }
    assert.equal(receipt.packages.find(({ name }) => name === "plain").artifact, "tarballs/plain/-/plain-2.0.0.tgz");
    assert.equal(await readFile(join(root, "registry", "client.npmrc"), "utf8"), "registry=http://127.0.0.1:4873/\n@customer:registry=http://127.0.0.1:4873/\naudit=false\nfund=false\n");
    assert.deepEqual((await readdir(join(root, "registry"))).sort(), ["client.npmrc", "metadata", "registry-receipt.json", "tarballs"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses a supplied integrity claim that differs from the artifact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-snapshot-assembly-integrity-"));
  try {
    const item = await release(root, "plain", "1.0.0");
    item.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
    await assert.rejects(() => assemblePackageRegistrySnapshot({ releases: [item], outputDirectory: join(root, "registry"), registryUrl: "http://127.0.0.1:4873/" }), /integrity differs from admitted claim/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses missing and symbolic-link artifact inputs before snapshot assembly", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-snapshot-assembly-artifact-"));
  try {
    const manifest = { name: "@customer/example", version: "1.0.0" };
    await assert.rejects(() => assemblePackageRegistrySnapshot({ releases: [{ manifest, artifactPath: join(root, "missing.tgz") }], outputDirectory: join(root, "missing"), registryUrl: "http://127.0.0.1:4873/" }), /existing regular file/u);
    const target = join(root, "target.tgz"), link = join(root, "link.tgz");
    await writeFile(target, "artifact\n");
    await symlink(target, link);
    await assert.rejects(() => assemblePackageRegistrySnapshot({ releases: [{ manifest, artifactPath: link }], outputDirectory: join(root, "link"), registryUrl: "http://127.0.0.1:4873/" }), /non-symbolic-link/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("merges a base snapshot and removes only explicitly excluded releases", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-snapshot-assembly-base-"));
  try {
    const base = join(root, "base");
    await assemblePackageRegistrySnapshot({ releases: [await release(root, "@customer/old", "1.0.0"), await release(root, "@customer/retained", "1.0.0")], outputDirectory: base, registryUrl: "http://127.0.0.1:4873/" });
    const next = await assemblePackageRegistrySnapshot({ releases: [], outputDirectory: join(root, "next"), baseRegistryDirectory: base, excludedBaseReleases: ["@customer/old@1.0.0"], registryUrl: "http://127.0.0.1:4873/" });
    assert.deepEqual(next.packages.map(({ name }) => name), ["@customer/retained"]);
    await assert.rejects(() => readFile(join(root, "next", "metadata", "%40customer%2Fold.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses metadata that retains a local dependency protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-snapshot-assembly-refusal-"));
  try {
    const consumer = await release(root, "@customer/consumer", "1.0.0", { dependencies: { "@customer/provider": "workspace:*" } });
    await assert.rejects(() => assemblePackageRegistrySnapshot({
      releases: [consumer],
      outputDirectory: join(root, "registry"), registryUrl: "http://127.0.0.1:4873/",
    }), /local dependency protocol survives/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses an output territory that is already occupied", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-snapshot-assembly-output-"));
  try {
    const output = join(root, "registry");
    await mkdir(output);
    await writeFile(join(output, "prior"), "not a snapshot\n");
    await assert.rejects(() => assemblePackageRegistrySnapshot({ releases: [], outputDirectory: output, registryUrl: "http://127.0.0.1:4873/" }), /territory must be empty/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
