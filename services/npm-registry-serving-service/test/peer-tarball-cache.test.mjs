import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNpmRegistry } from "../src/registry.mjs";

test("verified peer tarballs can be served without storing archive bytes", async t => {
  const storage = await mkdtemp(join(tmpdir(), "registry-peer-tarball-"));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const origin = "http://registry.invalid";
  const name = "@registry-fixture/replicated";
  const version = "1.0.0";
  const filename = "replicated-1.0.0.tgz";
  const url = `${origin}/${name}/-/${filename}`;
  const bytes = Buffer.from("fixture archive");
  const packument = {
    name,
    versions: {
      [version]: {
        name, version,
        dist: {
          tarball: url,
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          shasum: createHash("sha1").update(bytes).digest("hex"),
        },
      },
    },
  };
  let peerBytes = Buffer.from("different archive");
  const registry = createNpmRegistry({
    storage,
    origin,
    privateScopes: ["@registry-fixture"],
    cachePeerTarballs: false,
    peers: [{ name: "fixture", packument: async () => packument, artifact: async () => peerBytes }],
  });
  const request = init => registry.handle(new Request(url, init));

  assert.equal((await request()).status, 404);
  const metadataFiles = (await readdir(storage, { recursive: true })).sort();
  peerBytes = bytes;
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const head = await request({ method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(head.body, null);
  assert.equal((await request({ headers: { "if-none-match": response.headers.get("etag") } })).status, 304);
  assert.deepEqual((await readdir(storage, { recursive: true })).sort(), metadataFiles);
});
