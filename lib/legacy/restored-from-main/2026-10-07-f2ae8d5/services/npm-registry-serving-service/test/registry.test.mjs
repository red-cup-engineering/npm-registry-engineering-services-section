import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { createNpmRegistry } from "../src/registry.mjs";
import { npmRegistryApplication } from "../src/application.mjs";

const ORIGIN = "https://registry.example";
const basic = (user, password) => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` });

async function store() {
  const root = await mkdtemp(join(tmpdir(), "registry-"));
  const storage = join(root, "storage");
  await mkdir(join(storage, "@house", "kept"), { recursive: true });
  await writeFile(join(storage, "@house", "kept", "package.json"), JSON.stringify({
    name: "@house/kept", "dist-tags": { latest: "1.0.0" }, time: {}, _attachments: {}, _distfiles: {}, _uplinks: {}, _rev: "3-x",
    versions: { "1.0.0": { name: "@house/kept", version: "1.0.0", dist: { tarball: "https://old.example/@house/kept/-/kept-1.0.0.tgz", shasum: "x" } } },
  }));
  await writeFile(join(storage, "@house", "kept", "kept-1.0.0.tgz"), "kept bytes");
  const htpasswd = join(root, "htpasswd");
  await writeFile(htpasswd, `publisher:${bcrypt.hashSync("secret", 4).replace(/^\$2a\$/u, "$2y$")}:autocreated\n`);
  return { root, storage, htpasswd };
}

function uplink() {
  const calls = [];
  const bytes = Buffer.from("left-pad bytes");
  const shasum = createHash("sha1").update(bytes).digest("hex");
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === "https://upstream.example/left-pad") return Response.json({ name: "left-pad", "dist-tags": { latest: "1.3.0" },
      versions: { "1.3.0": { name: "left-pad", version: "1.3.0", dist: { tarball: "https://upstream.example/left-pad/-/left-pad-1.3.0.tgz", shasum } } } });
    if (String(url) === "https://upstream.example/left-pad/-/left-pad-1.3.0.tgz") return new Response(bytes);
    return new Response("{}", { status: 404 });
  };
  return { fetch, calls, bytes };
}

test("a house package is served from the store with every tarball on this registry and no bookkeeping", async () => {
  const { storage, htpasswd } = await store();
  const registry = createNpmRegistry({ storage, htpasswd, origin: ORIGIN, privateScopes: ["@house"], fetch: async () => { throw new Error("no uplink for house names"); } });
  for (const path of ["/@house%2fkept", "/@house/kept"]) {
    const packument = await (await registry.handle(new Request(`${ORIGIN}${path}`))).json();
    assert.equal(packument.versions["1.0.0"].dist.tarball, `${ORIGIN}/@house/kept/-/kept-1.0.0.tgz`);
    assert.equal(packument._rev, undefined);
  }
  const tarball = await registry.handle(new Request(`${ORIGIN}/@house/kept/-/kept-1.0.0.tgz`));
  assert.equal(await tarball.text(), "kept bytes");
  assert.equal((await registry.handle(new Request(`${ORIGIN}/@house/missing`))).status, 404);
});

test("an uplink package is fetched once, kept, and answered from the store while fresh", async () => {
  const { storage, htpasswd } = await store();
  const { fetch, calls, bytes } = uplink();
  const registry = createNpmRegistry({ storage, htpasswd, origin: ORIGIN, privateScopes: ["@house"], uplink: "https://upstream.example", fetch });
  const packument = await (await registry.handle(new Request(`${ORIGIN}/left-pad`))).json();
  assert.equal(packument.versions["1.3.0"].dist.tarball, `${ORIGIN}/left-pad/-/left-pad-1.3.0.tgz`);
  const tarball = await registry.handle(new Request(`${ORIGIN}/left-pad/-/left-pad-1.3.0.tgz`));
  assert.deepEqual(Buffer.from(await tarball.arrayBuffer()), bytes);
  await registry.handle(new Request(`${ORIGIN}/left-pad`));
  await registry.handle(new Request(`${ORIGIN}/left-pad/-/left-pad-1.3.0.tgz`));
  assert.deepEqual(calls, ["https://upstream.example/left-pad", "https://upstream.example/left-pad/-/left-pad-1.3.0.tgz"]);
  assert.deepEqual(await readFile(join(storage, "left-pad", "left-pad-1.3.0.tgz")), bytes);
});

test("publishing needs the htpasswd credential, keeps every version, and never replaces one", async () => {
  const { storage, htpasswd } = await store();
  const registry = createNpmRegistry({ storage, htpasswd, origin: ORIGIN, privateScopes: ["@house"], fetch: async () => new Response("{}", { status: 404 }) });
  const body = (version) => JSON.stringify({ name: "@house/kept", "dist-tags": { latest: version },
    versions: { [version]: { name: "@house/kept", version, dist: { tarball: `${ORIGIN}/@house/kept/-/kept-${version}.tgz` } } },
    _attachments: { [`kept-${version}.tgz`]: { data: Buffer.from(`v${version}`).toString("base64") } } });
  const put = (version, headers) => registry.handle(new Request(`${ORIGIN}/@house%2fkept`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: body(version) }));
  assert.equal((await put("1.1.0", {})).status, 401);
  assert.equal((await put("1.1.0", basic("publisher", "wrong"))).status, 401);
  assert.equal((await put("1.1.0", basic("publisher", "secret"))).status, 201);
  assert.equal((await put("1.1.0", basic("publisher", "secret"))).status, 409);
  const packument = await (await registry.handle(new Request(`${ORIGIN}/@house/kept`))).json();
  assert.deepEqual(Object.keys(packument.versions).sort(), ["1.0.0", "1.1.0"]);
  assert.equal(packument["dist-tags"].latest, "1.1.0");
  assert.equal(await (await registry.handle(new Request(`${ORIGIN}/@house/kept/-/kept-1.1.0.tgz`))).text(), "v1.1.0");
  const outside = await registry.handle(new Request(`${ORIGIN}/left-pad`, { method: "PUT", headers: basic("publisher", "secret"), body: "{}" }));
  assert.equal(outside.status, 403);
  assert.equal((await (await registry.handle(new Request(`${ORIGIN}/-/whoami`, { headers: basic("publisher", "secret") }))).json()).username, "publisher");
});

test("the application answers only its hosts and lets every other request through", async () => {
  const { root } = await store();
  const app = npmRegistryApplication({ configuration: { hosts: ["registry.example"], origin: ORIGIN, storage: join(root, "storage"), htpasswd: join(root, "htpasswd"), privateScopes: ["@house"] } });
  const context = (host, path) => { const request = new Request(`http://127.0.0.1:18818${path}`, { headers: { host } }); return { request, url: new URL(request.url) }; };
  assert.equal(app.onRequest(context("instance.example", "/@house/kept")), undefined);
  const answered = await app.onRequest(context("registry.example", "/@house/kept"));
  assert.equal((await answered.json()).name, "@house/kept");
});

test("on the native transport the application reads Node's request and passes other hosts through", async () => {
  const { root } = await store();
  const app = npmRegistryApplication({ configuration: { hosts: ["registry.example"], origin: ORIGIN, storage: join(root, "storage"), htpasswd: join(root, "htpasswd"), privateScopes: ["@house"] } });
  const native = (host, path) => ({ req: { method: "GET", headers: { host } }, url: new URL(`http://127.0.0.1:18818${path}`) });
  assert.equal(app.onRequest(native("instance.example", "/healthz")), undefined);
  const answered = await app.onRequest(native("registry.example", "/@house/kept"));
  assert.equal((await answered.json()).name, "@house/kept");
});
