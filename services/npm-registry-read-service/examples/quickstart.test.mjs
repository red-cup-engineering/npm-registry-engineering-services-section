import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  closeServer, createPackageRegistryServer, isNpmPackageName, listen,
} from "@red-cup-engineering/npm-registry-read-service";

test("REGISTRY-READ-QUICKSTART: receive prereleases through the installed reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "npm-registry-read-example-"));
  const releases = [
    {
      name: "@example.dev/my-package", version: "1.0.0-dev.1",
      snapshotPath: "tarballs/example.dev/my-package/-/my-package-1.0.0-dev.1.tgz",
      requestPath: "/@example.dev/my-package/-/my-package-1.0.0-dev.1.tgz",
      contents: Buffer.from("opaque scoped archive fixture\n"),
    },
    {
      name: "my-package", version: "1.0.0-dev.1",
      snapshotPath: "tarballs/my-package/-/my-package-1.0.0-dev.1.tgz",
      requestPath: "/my-package/-/my-package-1.0.0-dev.1.tgz",
      contents: Buffer.from("distinct unscoped archive fixture\n"),
    },
  ];
  async function write(relativePath, contents) {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  try {
    assert.equal(isNpmPackageName("punycode"), true);
    assert.equal(isNpmPackageName("@example.dev/my-package"), true);
    for (const { name, version, snapshotPath, contents } of releases) {
      await write(snapshotPath, contents);
      await write(`metadata/${encodeURIComponent(name)}.json`, JSON.stringify({
        name, "dist-tags": { latest: version },
        versions: { [version]: { name, version, dist: { tarball: `https://snapshot.example.test/${snapshotPath}` } } },
      }));
    }
    const server = createPackageRegistryServer({ registryDirectory: directory });
    await listen(server, { host: "127.0.0.1", port: 0 });
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const get = (url) => fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
      for (const { name, version, requestPath, contents } of releases) {
        const packument = await get(`${origin}/${encodeURIComponent(name)}`);
        assert.equal(packument.status, 200);
        const metadata = await packument.json();
        assert.equal(metadata["dist-tags"].latest, version);
        const published = metadata.versions[version];
        assert.equal(published.name, name);
        assert.equal(published.version, version);
        assert.equal(published.dist.tarball, origin + requestPath);
        const artifact = await get(published.dist.tarball);
        assert.equal(artifact.status, 200);
        assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), contents);
      }
      const absent = await get(`${origin}/my-package/-/my-package-1.0.0-dev.2.tgz`);
      assert.equal(absent.status, 404);
      assert.deepEqual(await absent.json(), { error: "not_found" });
    } finally { await closeServer(server); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
