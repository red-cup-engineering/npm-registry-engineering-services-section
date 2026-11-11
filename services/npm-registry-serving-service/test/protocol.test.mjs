import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import bcrypt from "bcryptjs";
import { npmRegistryApplication, npmRegistryHostedApplication } from "../src/application.mjs";
import { authorization, password, publishBody, registryFixture } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";

// The npm registry protocol as npm and pnpm speak it, beyond publishing and installing: revalidation, the shape of the
// full document, signing in, audit, and the hosted application a MetroPlat instance installs.

const name = "@registry-fixture/capability";
const escaped = encodeURIComponent(name);
const installAccept = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

test("a house packument carries a strong ETag per representation, and a client holding it is answered 304 until the package changes", async (t) => {
  const f = await registryFixture(t);
  assert.equal((await f.publish(packagedVersion(name, "1.0.0"))).status, 201);
  const full = await f.request(`/${escaped}`), install = await f.request(`/${escaped}`, { headers: { accept: installAccept } });
  const fullTag = full.headers.get("etag"), installTag = install.headers.get("etag");
  assert.match(fullTag, /^"[A-Za-z0-9_-]{32}"$/u);
  assert.notEqual(fullTag, installTag, "each representation is its own entity");
  assert.equal(full.headers.get("cache-control"), "no-cache", "a house package is revalidated every time, so a publish is seen at once");
  assert.equal(full.headers.get("last-modified"), new Date((await full.json()).time.modified).toUTCString());
  for (const match of [fullTag, `W/${fullTag}`, `"other", ${fullTag}`, "*"]) {
    const again = await f.request(`/${escaped}`, { headers: { "if-none-match": match } });
    assert.equal(again.status, 304, match);
    assert.equal(again.headers.get("etag"), fullTag);
    assert.equal(await again.text(), "");
  }
  assert.equal((await f.request(`/${escaped}`, { headers: { accept: installAccept, "if-none-match": fullTag } })).status, 200, "the full document's tag is not the install document's");
  assert.equal((await f.request(`/${escaped}`, { headers: { accept: installAccept, "if-none-match": installTag } })).status, 304);
  // pnpm sends its cached `modified` as If-Modified-Since too; with no If-None-Match it decides, exactly: an HTTP
  // date has whole seconds, so only one at or after the package's modified time answers 304.
  const modified = Date.parse(full.headers.get("last-modified")) + 1000;
  assert.equal((await f.request(`/${escaped}`, { headers: { "if-modified-since": new Date(modified).toUTCString() } })).status, 304);
  assert.equal((await f.request(`/${escaped}`, { headers: { "if-modified-since": new Date(modified - 2000).toUTCString() } })).status, 200);
  assert.equal((await f.publish(packagedVersion(name, "1.1.0"))).status, 201);
  const changed = await f.request(`/${escaped}`, { headers: { "if-none-match": fullTag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get("etag"), fullTag);
  assert.deepEqual(Object.keys((await changed.json()).versions), ["1.0.0", "1.1.0"]);
  const tagged = await f.request(`/-/package/${escaped}/dist-tags/beta`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: '"1.0.0"' });
  assert.equal(tagged.status, 201);
  assert.equal((await f.request(`/${escaped}`, { headers: { "if-none-match": changed.headers.get("etag") } })).status, 200, "a tag moving is a change");
});

test("a house tarball is immutable: cached for a year, with its shasum as its ETag", async (t) => {
  const f = await registryFixture(t);
  const bytes = packagedVersion(name, "1.0.0");
  assert.equal((await f.publish(bytes)).status, 201);
  const response = await f.request(`/${escaped}/-/capability-1.0.0.tgz`);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const etag = response.headers.get("etag");
  assert.equal(etag, `"${(await (await f.request(`/${escaped}/1.0.0`)).json()).dist.shasum}"`);
  assert.equal((await f.request(`/${escaped}/-/capability-1.0.0.tgz`, { headers: { "if-none-match": etag } })).status, 304);
  const head = await f.request(`/${escaped}/-/capability-1.0.0.tgz`, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(await head.text(), "");
});

test("a public packument is revalidated like npm's own: an ETag of what was sent, cacheable for five minutes", async (t) => {
  const f = await registryFixture(t, { fetch: async () => Response.json({ name: "left-pad", "dist-tags": { latest: "1.0.0" }, time: { modified: "2020-01-01T00:00:00.000Z" }, versions: { "1.0.0": { name: "left-pad", version: "1.0.0", dist: { tarball: "https://uplink.invalid/left-pad-1.0.0.tgz", shasum: "a".repeat(40) } } } }) });
  const response = await f.request("/left-pad", { headers: { accept: installAccept } });
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("last-modified"), "Wed, 01 Jan 2020 00:00:00 GMT");
  assert.equal((await f.request("/left-pad", { headers: { accept: installAccept, "if-none-match": response.headers.get("etag") } })).status, 304);
});

test("the full packument is npm's: _id and _rev, latest's description and repository, publishers as maintainers, the shipped readme", async (t) => {
  const f = await registryFixture(t);
  const readme = "# Capability\n\nWhat it does.\n";
  const first = packagedVersion(name, "1.0.0", { manifest: { description: "first", license: "MIT", keywords: ["fixture"] }, files: { "README.md": readme } });
  assert.equal((await f.publish(first)).status, 201);
  const one = await (await f.request(`/${escaped}`)).json();
  assert.equal(one._id, name);
  assert.match(one._rev, /^3-/u, "three facts: the publication, its tag, and the readme it shipped");
  assert.deepEqual([one.description, one.license, one.keywords, one.readme], ["first", "MIT", ["fixture"], readme]);
  assert.deepEqual(one.maintainers, [{ name: "fixture" }]);
  assert.equal((await f.publish(packagedVersion(name, "2.0.0", { manifest: { description: "second" }, files: { "README.md": readme } }))).status, 201);
  const two = await (await f.request(`/${escaped}`)).json();
  assert.equal(two.description, "second", "top-level fields follow latest");
  assert.notEqual(two._rev, one._rev);
  const owners = structuredClone(two); owners.maintainers = [{ name: "fixture" }, { name: "someone" }];
  const refused = await f.put(name, owners);
  assert.equal(refused.status, 409, "npm owner add is not a way to change who published");
  assert.match((await refused.json()).error, /maintainers/u);
});

test("npm login signs a publisher in with a token; the token publishes, answers whoami, and is revoked by npm logout", async (t) => {
  const f = await registryFixture(t);
  const signIn = (user, secret) => f.request(`/-/user/org.couchdb.user:${encodeURIComponent(user)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ _id: `org.couchdb.user:${user}`, name: user, password: secret, type: "user", roles: [], date: new Date().toISOString() }) });
  assert.equal((await signIn("fixture", "wrong")).status, 401);
  const stranger = await signIn("stranger", password);
  assert.equal(stranger.status, 401);
  assert.match((await stranger.json()).error, /operator/u, "signing in never creates an account");
  assert.equal((await f.request("/-/v1/login", { method: "POST", body: "{}" })).status, 404, "web login is not offered, so npm falls back to this one");
  const signedIn = await signIn("fixture", password);
  assert.equal(signedIn.status, 201);
  const { token } = await signedIn.json();
  assert.match(token, /^hnr_[A-Za-z0-9_-]{43}$/u);
  const bearer = { authorization: `Bearer ${token}` };
  assert.deepEqual(await (await f.request("/-/whoami", { headers: bearer })).json(), { username: "fixture" });
  const body = publishBody(packagedVersion(name, "1.0.0"), { origin: f.origin });
  assert.equal((await f.put(name, body, bearer)).status, 201);
  assert.deepEqual((await (await f.request(`/${escaped}/1.0.0`)).json())._npmUser, { name: "fixture" });
  assert.equal((await f.request(`/-/user/token/${token}`, { method: "DELETE" })).status, 401, "a token is revoked by its holder");
  assert.equal((await f.request(`/-/user/token/${token}`, { method: "DELETE", headers: bearer })).status, 200);
  assert.equal((await f.request("/-/whoami", { headers: bearer })).status, 401);
  assert.equal((await f.put(name, publishBody(packagedVersion(name, "1.1.0"), { origin: f.origin }), bearer)).status, 401);
});

test("a publisher the operator adds to htpasswd can publish without a restart", async (t) => {
  const f = await registryFixture(t);
  const late = `Basic ${Buffer.from("late:late-secret").toString("base64")}`;
  assert.equal((await f.request("/-/whoami", { headers: { authorization: late } })).status, 401);
  await appendFile(join(f.root, "htpasswd"), `late:${bcrypt.hashSync("late-secret", 4)}:autocreated 2026-10-21\n`);
  assert.deepEqual(await (await f.request("/-/whoami", { headers: { authorization: late } })).json(), { username: "late" });
});

test("npm audit reaches the uplink without the house's names", async (t) => {
  const forwarded = [];
  const f = await registryFixture(t, { fetch: async (url, init) => { forwarded.push({ url, body: JSON.parse(init.body) }); return Response.json({ "left-pad": [] }); } });
  const inventory = { "left-pad": ["1.3.0"], [name]: ["1.0.0"], "@red-cup-engineering/metroplat": ["0.9.10"] };
  const response = await f.request("/-/npm/v1/security/advisories/bulk", { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: gzipSync(JSON.stringify(inventory)) });
  assert.deepEqual(await response.json(), { "left-pad": [] });
  assert.deepEqual(forwarded, [{ url: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", body: { "left-pad": ["1.3.0"] } }]);
  const houseOnly = await f.request("/-/npm/v1/security/advisories/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [name]: ["1.0.0"] }) });
  assert.deepEqual(await houseOnly.json(), {});
  assert.equal(forwarded.length, 1, "nothing to ask the uplink about");
});

test("a dist-tag is changed only on a house package", async (t) => {
  const f = await registryFixture(t, { fetch: async () => { throw new Error("not reached"); } });
  const response = await f.request("/-/package/left-pad/dist-tags/beta", { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: '"1.0.0"' });
  assert.equal(response.status, 403);
});

async function hostedConfiguration(t) {
  const root = await mkdtemp(join(tmpdir(), "house-registry-hosted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "htpasswd"), `fixture:${bcrypt.hashSync(password, 4)}\n`);
  return { hosts: ["registry.example.test"], origin: "https://registry.example.test", storage: join(root, "storage"), htpasswd: join(root, "htpasswd"), privateScopes: ["@registry-fixture"], receiveAtStart: false };
}

test("as a MetroPlat hosted application the registry declares its hosts and its own authentication, and answers with fetch", async (t) => {
  const configuration = await hostedConfiguration(t);
  const hosted = npmRegistryHostedApplication({ configuration });
  // The shape FeltOS's entrance admits for a hosted application (admitHosted): hosts it answers, how it
  // authenticates its own state changes, and a fetch over Web Requests.
  assert.deepEqual(hosted.hosts, ["registry.example.test"]);
  assert.equal(typeof hosted.authentication.scheme, "string");
  assert.equal(typeof hosted.fetch, "function");
  assert.deepEqual(await (await hosted.fetch(new Request("https://registry.example.test/-/ping"))).json(), {});
  const body = publishBody(packagedVersion(name, "1.0.0"), { origin: configuration.origin });
  const put = await hosted.fetch(new Request(`https://registry.example.test/${escaped}`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal(put.status, 201);
  // The host builds its entrance more than once; each build gets the same registry over the same store.
  const rebuilt = npmRegistryHostedApplication({ configuration: structuredClone(configuration) });
  const served = await (await rebuilt.fetch(new Request(`https://registry.example.test/${escaped}`))).json();
  assert.equal(served.versions["1.0.0"].dist.tarball, `https://registry.example.test/${name}/-/capability-1.0.0.tgz`);
  const standalone = npmRegistryApplication({ configuration });
  assert.equal(standalone.onRequest({ request: new Request("https://elsewhere.example.test/-/ping"), url: new URL("https://elsewhere.example.test/-/ping") }), undefined, "another host's request passes through");
});

test("a hosted registry's configuration is exact: every key known, its origin one of its hosts, one configuration per store", async (t) => {
  const configuration = await hostedConfiguration(t);
  assert.throws(() => npmRegistryHostedApplication({ configuration: { ...configuration, storgae: "typo" } }), /does not declare storgae/u);
  assert.throws(() => npmRegistryHostedApplication({ configuration: { ...configuration, origin: "https://elsewhere.example.test" } }), /origin is one of the hosts/u);
  assert.throws(() => npmRegistryHostedApplication({ configuration: { ...configuration, hosts: [] } }), /names the hosts/u);
  npmRegistryHostedApplication({ configuration });
  assert.throws(() => npmRegistryHostedApplication({ configuration: { ...configuration, privateNames: ["other"] } }), /already served by a registry with another configuration/u);
});
