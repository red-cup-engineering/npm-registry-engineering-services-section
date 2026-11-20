import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGuixArchiveBucket } from "../src/guix-archive-bucket.mjs";

const key = "@house/example/-/example-0.1.0.tgz";
const archive = Buffer.from("qualified compressed package");
const createOnce = { onlyIf: { etagDoesNotMatch: "*" } };
const checksum = b => "sha512-" + createHash("sha512").update(b).digest("base64");

async function fixture(t, { rewrite = value => value, externalRoots = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lagoon-guix-archive-bucket-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "state"), storeDirectory = join(directory, "store");
  await mkdir(storeDirectory);
  const calls = [], objects = new Map();
  const metadataBucket = Object.fromEntries(["get", "head", "put", "delete"].map(method => [
    method, (...args) => { calls.push([method, ...args]); return "base reply"; },
  ]));
  const register = async (source, gcRoot) => {
    const value = rewrite(await readFile(source));
    const name = createHash("sha256").update(value).digest("hex") + "-npm.tgz";
    const storePath = join(storeDirectory, name);
    try {
      await writeFile(storePath, value, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await symlink(storePath, gcRoot);
    objects.set(gcRoot, storePath);
    return storePath;
  };
  const collectorDirectory = externalRoots ? join(directory, "public-roots") : undefined;
  const open = () => createGuixArchiveBucket({ metadataBucket, root, storeDirectory, register, collectorDirectory });
  return { bucket: await open(), root, collectorDirectory, calls, objects, open };
}

test("places only immutable package archives in Guix and keeps the base metadata API", async t => {
  const { bucket, root, collectorDirectory, calls, open } = await fixture(t, { externalRoots: true });
  const metadata = "@house/example/index.json", claim = "-/publication-inputs/@house/example/0.1.0.json";
  assert.equal(await bucket.put(metadata, "packument", createOnce), "base reply");
  assert.equal(await bucket.get(claim), "base reply");
  const first = await bucket.put(key, archive, createOnce);
  assert.equal((await readdir(collectorDirectory)).length, 1);
  const reopened = await open();
  assert.equal((await reopened.head(key)).customMetadata.integrity, checksum(archive));
  assert.equal((await reopened.head(key)).httpEtag, first.httpEtag);
  const read = await reopened.get(key);
  assert.deepEqual(Buffer.from(await new Response(read.body).arrayBuffer()), archive);
  await reopened.delete(key);
  assert.equal(await bucket.head(key), null);
  assert.deepEqual(await readdir(join(root, "roots")), []);
  assert.deepEqual(await readdir(collectorDirectory), []);
  assert.deepEqual(calls, [["put", metadata, "packument", createOnce], ["get", claim]]);
});

test("concurrent writes cannot replace an archive, and identical bytes use one object across keys", async t => {
  const { bucket, objects, root } = await fixture(t);
  const replies = await Promise.all([bucket.put(key, archive, createOnce), bucket.put(key, archive, createOnce)]);
  assert.equal(replies.filter(Boolean).length, 1);
  const alias = "another/-/another-0.1.0.tgz";
  await bucket.put(alias, archive, createOnce);
  assert.equal(new Set(objects.values()).size, 1);
  assert.equal((await readdir(join(root, "roots"))).length, 2);
  assert.equal(await bucket.put(key, Buffer.from("replacement"), createOnce), null);
  const inFlight = await bucket.get(key);
  await bucket.delete(key);
  assert.deepEqual(Buffer.from(await new Response(inFlight.body).arrayBuffer()), archive);
  assert.equal((await bucket.head(alias)).customMetadata.integrity, checksum(archive));
});

test("failed integrity and mismatched store content never publish a custody receipt", async t => {
  const { bucket, root, collectorDirectory } = await fixture(t, {
    rewrite: () => Buffer.from("unexpected bytes"), externalRoots: true,
  });
  await assert.rejects(bucket.put(key, archive, {
    ...createOnce, customMetadata: { integrity: checksum(Buffer.from("wrong")) },
  }), /expected integrity/);
  await assert.rejects(bucket.put(key, archive, createOnce), /registered Guix archive differs/);
  assert.equal(await bucket.head(key), null);
  assert.deepEqual(await readdir(join(root, "roots")), []);
  assert.deepEqual(await readdir(collectorDirectory), []);
});
