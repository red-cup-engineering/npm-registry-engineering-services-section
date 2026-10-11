import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";

import { createPackageRegistryServer, resolvePackageRegistryRequest, rewriteMetadataTarballOrigins } from "../src/npm-registry-read-service.mjs";

async function writeRegistrySnapshot(root, version = "1.0.0") {
  await mkdir(join(root, "metadata"), { recursive: true });
  await mkdir(join(root, "tarballs", "customer", "example", "-"), { recursive: true });
  await writeFile(join(root, "metadata", "%40customer%2Fexample.json"), `${JSON.stringify({ name: "@customer/example", versions: { [version]: { name: "@customer/example", version, dist: { tarball: `http://registry.invalid/tarballs/customer/example/-/example-${version}.tgz` } } } })}\n`);
  await writeFile(join(root, "tarballs", "customer", "example", "-", `example-${version}.tgz`), Buffer.from(version, "utf8"));
}

async function registryFixture() {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-read-"));
  await writeRegistrySnapshot(root);
  return root;
}

function registryRequest(registryDirectory, { method = "GET", path, host = "registry.example.test" }) {
  const server = createPackageRegistryServer({ registryDirectory });
  const response = new PassThrough();
  const chunks = [];
  const headers = {};
  response.on("data", (chunk) => chunks.push(chunk));
  response.writeHead = (status, suppliedHeaders = {}) => {
    response.status = status;
    Object.assign(headers, suppliedHeaders);
    return response;
  };
  server.emit("request", { method, url: path, headers: { host } }, response);
  return finished(response).then(() => ({ status: response.status, headers, body: Buffer.concat(chunks) }));
}

test("serves npm ping and method semantics", async () => {
  const root = await registryFixture();
  try {
    const ping = await registryRequest(root, { path: "/-/ping" });
    assert.equal(ping.status, 200);
    assert.deepEqual(JSON.parse(ping.body), {});
    const headPing = await registryRequest(root, { method: "HEAD", path: "/-/ping" });
    assert.equal(headPing.status, 200);
    assert.equal(headPing.body.byteLength, 0);
    const rejected = await registryRequest(root, { method: "POST", path: "/-/ping" });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.allow, "GET, HEAD");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("serves packuments with the requesting face and supports HEAD", async () => {
  const root = await registryFixture();
  try {
    const packument = await registryRequest(root, { path: "/@customer%2Fexample" });
    assert.equal(packument.status, 200);
    assert.equal(packument.headers["content-type"], "application/json");
    assert.equal(packument.headers["cache-control"], "no-cache");
    assert.equal(JSON.parse(packument.body).versions["1.0.0"].dist.tarball, "http://registry.example.test/tarballs/customer/example/-/example-1.0.0.tgz");
    const head = await registryRequest(root, { method: "HEAD", path: "/@customer%2Fexample" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers["content-length"]) > 0, true);
    assert.equal(head.body.byteLength, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("serves unscoped packuments from the same closed snapshot", async () => {
  const root = await registryFixture();
  try {
    await writeFile(join(root, "metadata", "plain.json"), `${JSON.stringify({ name: "plain", versions: { "1.0.0": { name: "plain", version: "1.0.0" } } })}\n`);
    const packument = await registryRequest(root, { path: "/plain" });
    assert.equal(packument.status, 200);
    assert.equal(JSON.parse(packument.body).name, "plain");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("serves tarballs as immutable binary artifacts and rejects escaped paths", async () => {
  const root = await registryFixture();
  try {
    const tarball = await registryRequest(root, { path: "/tarballs/customer/example/-/example-1.0.0.tgz" });
    assert.equal(tarball.status, 200);
    assert.equal(tarball.headers["content-type"], "application/octet-stream");
    assert.equal(tarball.headers["cache-control"], "public, immutable");
    assert.deepEqual(tarball.body, Buffer.from("1.0.0", "utf8"));
    const canonicalClientPath = await registryRequest(root, { path: "/@customer/example/-/@customer/example-1.0.0.tgz" });
    assert.equal(canonicalClientPath.status, 200);
    assert.deepEqual(canonicalClientPath.body, Buffer.from("1.0.0", "utf8"));
    const head = await registryRequest(root, { method: "HEAD", path: "/tarballs/customer/example/-/example-1.0.0.tgz" });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], 5);
    assert.equal(head.body.byteLength, 0);
    assert.equal(await resolvePackageRegistryRequest({ registryDirectory: root, requestPath: "/../../etc/passwd" }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rewrites only tarball origins without mutating source metadata", () => {
  const metadata = { versions: { "1.0.0": { dist: { tarball: "http://registry.invalid/tarballs/customer/example/-/example-1.0.0.tgz" } } } };
  const rewritten = rewriteMetadataTarballOrigins(metadata, "https://registry.example.test");
  assert.equal(rewritten.versions["1.0.0"].dist.tarball, "https://registry.example.test/tarballs/customer/example/-/example-1.0.0.tgz");
  assert.equal(metadata.versions["1.0.0"].dist.tarball, "http://registry.invalid/tarballs/customer/example/-/example-1.0.0.tgz");
});

test("a long-lived reader follows atomic current-pointer replacement lexically", async () => {
  const host = await mkdtemp(join(tmpdir(), "npm-registry-host-"));
  try {
    const snapshots = join(host, "snapshots");
    const first = join(snapshots, "a");
    const second = join(snapshots, "b");
    await mkdir(snapshots);
    await writeRegistrySnapshot(first, "1.0.0");
    await writeRegistrySnapshot(second, "2.0.0");
    await symlink(join("snapshots", "a"), join(host, "current"));

    const server = createPackageRegistryServer({ registryDirectory: join(host, "current") });
    const firstResponse = await registryRequest(join(host, "current"), { path: "/@customer%2Fexample" });
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(firstResponse.body).versions), ["1.0.0"]);

    await symlink(join("snapshots", "b"), join(host, "next"));
    await rename(join(host, "next"), join(host, "current"));

    const response = new PassThrough();
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.writeHead = (status) => { response.status = status; return response; };
    server.emit("request", { method: "GET", url: "/@customer%2Fexample", headers: { host: "registry.example.test" } }, response);
    await finished(response);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(Buffer.concat(chunks)).versions), ["2.0.0"]);
  } finally { await rm(host, { recursive: true, force: true }); }
});

test("a tarball opened before activation is measured and streamed from one snapshot descriptor", async () => {
  const host = await mkdtemp(join(tmpdir(), "npm-registry-host-"));
  try {
    const snapshots = join(host, "snapshots");
    const first = join(snapshots, "a");
    const second = join(snapshots, "b");
    await mkdir(snapshots);
    await writeRegistrySnapshot(first, "1.0.0");
    await writeRegistrySnapshot(second, "2.0.0");
    await symlink(join("snapshots", "a"), join(host, "current"));
    let activated = false;
    const server = createPackageRegistryServer({
      registryDirectory: join(host, "current"),
      openFile: async (path) => {
        const file = await open(path);
        await symlink(join("snapshots", "b"), join(host, "next"));
        await rename(join(host, "next"), join(host, "current"));
        activated = true;
        return file;
      },
    });
    const response = new PassThrough();
    const chunks = [];
    const headers = {};
    response.on("data", (chunk) => chunks.push(chunk));
    response.writeHead = (status, suppliedHeaders = {}) => {
      response.status = status;
      Object.assign(headers, suppliedHeaders);
      return response;
    };
    server.emit("request", { method: "GET", url: "/tarballs/customer/example/-/example-1.0.0.tgz", headers: { host: "registry.example.test" } }, response);
    await finished(response);
    assert.equal(activated, true);
    assert.equal(response.status, 200);
    assert.equal(headers["content-length"], Buffer.byteLength("1.0.0"));
    assert.deepEqual(Buffer.concat(chunks), Buffer.from("1.0.0", "utf8"));
  } finally { await rm(host, { recursive: true, force: true }); }
});
