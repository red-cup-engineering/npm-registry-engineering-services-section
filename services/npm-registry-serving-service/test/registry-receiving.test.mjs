import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { createNpmRegistry } from "../src/registry.mjs";

const run = promisify(execFile);
const name = "@registry-fixture/capability";
const password = "local-disposable-test-only";
const authorization = `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`;
const digest = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);
function publication(version = "1.0.0", bytes = Buffer.from("fixture artifact")) {
  const file = `capability-${version}.tgz`;
  return {
    name, versions: { [version]: { name, version, dist: {
      tarball: `http://registry.invalid/${name}/-/${name}-${version}.tgz`,
      shasum: digest("sha1", bytes, "hex"), integrity: `sha512-${digest("sha512", bytes, "base64")}`,
    } } }, "dist-tags": { latest: version },
    _attachments: { [`${name}-${version}.tgz`]: { data: bytes.toString("base64"), length: bytes.length, content_type: "application/octet-stream" } },
  };
}
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "house-registry-receiving-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const htpasswd = join(root, "htpasswd");
  await writeFile(htpasswd, `fixture:${bcrypt.hashSync(password, 4)}\n`);
  const storage = join(root, "storage");
  const origin = "http://registry.invalid";
  const registry = createNpmRegistry({ storage, htpasswd, origin, privateScopes: ["@registry-fixture"], ...extra });
  const request = (path, options) => registry.handle(new Request(`${origin}${path}`, options));
  const publish = (body) => request(`/${encodeURIComponent(name)}`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { root, storage, htpasswd, request, publish };
}

test("scoped npm attachment is admitted once under its canonical served identity", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("exact original bytes");
  assert.equal((await f.publish(publication("1.0.0", bytes))).status, 201);
  const packument = await (await f.request(`/${encodeURIComponent(name)}`)).json();
  const manifest = packument.versions["1.0.0"];
  const response = await f.request(new URL(manifest.dist.tarball).pathname);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(await (await f.request(`/${encodeURIComponent(name)}/1.0.0`)).json(), manifest);
  assert.deepEqual(await (await f.request(`/${name}/latest`)).json(), manifest);
  assert.deepEqual(await (await f.request(`/-/package/${encodeURIComponent(name)}/dist-tags`)).json(), { latest: "1.0.0" });
  assert.equal(await (await f.request(`/-/package/${encodeURIComponent(name)}/dist-tags/latest`)).json(), "1.0.0");
  assert.equal((await f.request(`/${name}/9.9.9`)).status, 404);
});

test("publication rejects the whole transaction before writes for inconsistent artifacts", async (t) => {
  const cases = [
    ["manifest identity", b => { b.versions["1.0.0"].name = "@registry-fixture/other"; }],
    ["manifest version", b => { b.versions["1.0.0"].version = "2.0.0"; }],
    ["shasum", b => { b.versions["1.0.0"].dist.shasum = "0".repeat(40); }],
    ["integrity", b => { b.versions["1.0.0"].dist.integrity = `sha512-${"A".repeat(88)}`; }],
    ["attachment length", b => { Object.values(b._attachments)[0].length += 1; }],
    ["attachment encoding", b => { Object.values(b._attachments)[0].data = "not base64!"; }],
    ["base64 pad bits", b => { Object.assign(b, publication("1.0.0", Buffer.from([0]))); Object.values(b._attachments)[0].data = "AB=="; }],
    ["unbound tag", b => { b["dist-tags"].latest = "9.9.9"; }],
    ["missing attachment", b => { b._attachments = {}; }],
    ["unreferenced attachment", b => { b._attachments["extra.tgz"] = Object.values(b._attachments)[0]; }],
    ["different artifact path", b => { b.versions["1.0.0"].dist.tarball = "http://registry.invalid/other.tgz"; }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async (t) => {
    const f = await fixture(t); const body = publication(); mutate(body);
    assert.equal((await f.publish(body)).status, 400);
    assert.equal((await f.request(`/${name}`)).status, 404);
    await assert.rejects(readFile(join(f.storage, name, "capability-1.0.0.tgz")), { code: "ENOENT" });
  });
});

test("occupied artifact bytes and published versions remain immutable under races", async (t) => {
  const f = await fixture(t); const bytes = Buffer.from("kept");
  const body = publication("1.0.0", bytes);
  const results = await Promise.all([f.publish(body), f.publish(body)]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const before = await readFile(join(f.storage, name, "package.json"));
  assert.equal((await f.publish(publication("1.0.0", Buffer.from("replacement")))).status, 409);
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), before);
  assert.deepEqual(await readFile(join(f.storage, name, "capability-1.0.0.tgz")), bytes);
  const next = Buffer.from("orphan from interrupted publication");
  await writeFile(join(f.storage, name, "capability-1.0.1.tgz"), next);
  assert.equal((await f.publish(publication("1.0.1", Buffer.from("other bytes")))).status, 409);
  assert.deepEqual(await readFile(join(f.storage, name, "capability-1.0.1.tgz")), next);
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), before);
  assert.equal((await f.publish(publication("1.0.1", next))).status, 201);
});

test("independent simultaneous versions preserve both metadata entries", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([f.publish(publication("1.0.0")), f.publish(publication("1.0.1"))]);
  assert.deepEqual(responses.map(r => r.status), [201, 201]);
  const stored = JSON.parse(await readFile(join(f.storage, name, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(stored.versions).sort(), ["1.0.0", "1.0.1"]);
});

test("a later artifact collision refuses every new version before committing bytes", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.storage, name), { recursive: true });
  await writeFile(join(f.storage, name, "capability-1.0.1.tgz"), "occupied bytes");
  const first = publication("1.0.0"), second = publication("1.0.1");
  const body = { ...first, versions: { ...first.versions, ...second.versions }, _attachments: { ...first._attachments, ...second._attachments } };
  assert.equal((await f.publish(body)).status, 409);
  await assert.rejects(readFile(join(f.storage, name, "capability-1.0.0.tgz")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.storage, name, "package.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.storage, name, "capability-1.0.1.tgz"), "utf8"), "occupied bytes");
});

test("an unwritable artifact leaves the prior version and advertised metadata unchanged", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.publish(publication())).status, 201);
  const before = await readFile(join(f.storage, name, "package.json"));
  await mkdir(join(f.storage, name, "capability-1.0.1.tgz"));
  await assert.rejects(f.publish(publication("1.0.1")), { code: "EISDIR" });
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), before);
  assert.equal((await f.request(`/${name}/1.0.0`)).status, 200);
  assert.equal((await f.request(`/${name}/1.0.1`)).status, 404);
});

test("public uplink and existing leaf-key store remain usable", async (t) => {
  const bytes = Buffer.from("public artifact");
  const f = await fixture(t, { fetch: async (url) => url.endsWith(".tgz") ? new Response(bytes) : Response.json({ name: "example", versions: { "1.0.0": { name: "example", version: "1.0.0", dist: { tarball: "https://uplink.invalid/example-1.0.0.tgz", shasum: digest("sha1", bytes, "hex") } } }, "dist-tags": { latest: "1.0.0" } }) });
  assert.equal((await f.request("/example/1.0.0")).status, 200);
  assert.deepEqual(Buffer.from(await (await f.request("/example/-/example-1.0.0.tgz")).arrayBuffer()), bytes);
  const body = publication(); const [key, attachment] = Object.entries(body._attachments)[0];
  body._attachments = { [key.split("/").at(-1)]: attachment };
  assert.equal((await f.publish(body)).status, 201);
  assert.equal((await f.request(`/${name}/-/capability-1.0.0.tgz`)).status, 200);
  assert.equal((await f.request(`/${name}`, { method: "PUT", body: JSON.stringify(publication("2.0.0")) })).status, 401);
});

test("all metadata routes retain package-name storage confinement", async (t) => {
  const f = await fixture(t, { fetch: async () => { throw new Error("invalid names must not reach the uplink"); } });
  await mkdir(join(f.root, "outside"));
  await writeFile(join(f.root, "outside", "package.json"), JSON.stringify({ name: "outside", "dist-tags": { latest: "escaped" } }));
  for (const malformed of ["../outside", "@fixture/../../outside", "/absolute", "plain/name", "@fixture/", "@", "-private", "back\\slash", "bad\u0000name"]) {
    const path = `/-/package/${encodeURIComponent(malformed)}/dist-tags`;
    assert.equal((await f.request(path)).status, 404, malformed);
    assert.equal((await f.request(`${path}/latest`)).status, 404, malformed);
    assert.equal((await f.request(`${path}/latest`, { method: "PUT", headers: { authorization }, body: '"1.0.0"' })).status, 404, malformed);
  }
  assert.equal((await f.request("/@fixture%2F..%2Foutside")).status, 404);
  assert.equal((await f.request("/-/package/%zz/dist-tags")).status, 400);
  for (const method of ["GET", "HEAD", "PUT"]) {
    assert.equal((await f.request(`/-/package/${encodeURIComponent(name)}/dist-tags/%zz`, { method, ...(method === "PUT" ? { headers: { authorization }, body: '"1.0.0"' } : {}) })).status, 400);
  }
  assert.equal((await f.request("/%zz")).status, 400);
  assert.equal(JSON.parse(await readFile(join(f.root, "outside", "package.json"), "utf8"))["dist-tags"].latest, "escaped");
});

for (const packageName of [name, "registry-fixture-capability"]) test(`real npm publishes and installs ${packageName} through the standalone serving entrypoint`, { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const probe = createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const config = join(f.root, "registry.json");
  await writeFile(config, JSON.stringify({ hosts: ["127.0.0.1"], origin, storage: f.storage, htpasswd: f.htpasswd, privateScopes: ["@registry-fixture"], privateNames: ["registry-fixture-capability"] }));
  const server = spawn(process.execPath, [fileURLToPath(new URL("../bin/serve.mjs", import.meta.url)), config], { env: { PATH: process.env.PATH, NPM_REGISTRY_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; server.stderr.on("data", b => { errors += b; });
  t.after(async () => { if (server.exitCode === null) { server.kill("SIGTERM"); await new Promise(r => server.once("exit", r)); } });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/-/ping`)).ok) break; } catch { /* wait for real entrypoint */ }
    if (attempt === 100 || server.exitCode !== null) throw new Error(`registry did not start: ${errors}`);
    await new Promise(r => setTimeout(r, 20));
  }
  const packageDir = join(f.root, "publisher"), consumer = join(f.root, "consumer");
  await mkdir(packageDir); await mkdir(consumer);
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0", type: "module", exports: "./index.mjs", files: ["index.mjs"] }));
  await writeFile(join(packageDir, "index.mjs"), 'export const received = "exact packed carrier";\n');
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const userconfig = join(f.root, "npmrc"), globalconfig = join(f.root, "global-npmrc");
  await writeFile(userconfig, `registry=${origin}\n//127.0.0.1:${port}/:username=fixture\n//127.0.0.1:${port}/:_password=${Buffer.from(password).toString("base64")}\n`);
  await writeFile(globalconfig, "");
  const env = { PATH: process.env.PATH, HOME: f.root, NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig, NPM_CONFIG_CACHE: join(f.root, "cache"), NO_PROXY: "127.0.0.1" };
  await run("npm", ["publish", "--ignore-scripts", "--provenance=false", "--registry", origin], { cwd: packageDir, env });
  const metadata = await (await fetch(`${origin}/${encodeURIComponent(packageName)}`)).json();
  const artifact = await fetch(metadata.versions["1.0.0"].dist.tarball);
  assert.equal(artifact.status, 200, "a successful npm publish must immediately serve its advertised artifact");
  assert.equal(`sha512-${digest("sha512", Buffer.from(await artifact.arrayBuffer()), "base64")}`, metadata.versions["1.0.0"].dist.integrity);
  await run("npm", ["install", `${packageName}@1.0.0`, "--ignore-scripts", "--no-audit", "--no-fund", "--registry", origin], { cwd: consumer, env });
  const received = await run(process.execPath, ["--input-type=module", "-e", `process.stdout.write((await import(${JSON.stringify(packageName)})).received)`], { cwd: consumer, env });
  assert.equal(received.stdout, "exact packed carrier");
  const tags = await run("npm", ["dist-tag", "ls", packageName, "--registry", origin], { cwd: consumer, env });
  assert.match(tags.stdout, /latest: 1\.0\.0/u);
});
