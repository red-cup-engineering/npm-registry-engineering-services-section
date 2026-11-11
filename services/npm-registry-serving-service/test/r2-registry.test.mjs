import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createR2Registry } from "../src/r2-registry.mjs";
import { registryFixture, authorization, publishBody } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { MemoryR2 } from "./support/r2.mjs";

const origin = "https://registry.invalid";
const name = "@registry-fixture/r2-example";
const custodyKey = version => "-/publication-inputs/" + name + "/" + version + ".json";
const archiveKey = version => name + "/-/r2-example-" + version + ".tgz";
const indexKey = name + "/index.json";
const configuration = extra => ({
  origin, privateScopes: ["@registry-fixture", "@red-cup-engineering"], privateNames: [],
  nativePublisherPolicy: "native-authenticated-house-publishers-v1", ...extra,
});
function publication(version = "1.0.0", extra = {}) {
  const bytes = packagedVersion(name, version, { manifest: {
    gitHead: "1".repeat(40), scripts: { test: "node --test" }, devDependencies: { "external-fixture": "1.0.0" },
    ...extra,
  } });
  return { bytes, body: publishBody(bytes, { origin }) };
}
async function fixture(t, { bucket = new MemoryR2(), config = {}, nativeOptions = {}, publishToken = "fixture-r2-authority", uplinkFetch } = {}) {
  const native = await registryFixture(t, { origin, ...nativeOptions }), nativeCalls = [];
  const receiver = createR2Registry({ bucket, configuration: configuration(config), publishToken,
    uplinkFetch: uplinkFetch ?? (async request => { throw new Error("unexpected public read " + request.url); }),
    nativeFetch: request => { assert.equal(request.redirect, "manual", "Workers supports manual redirect custody, not Request.redirect error"); nativeCalls.push({ method: request.method, url: request.url, redirect: request.redirect }); return native.request(new URL(request.url).pathname + new URL(request.url).search, {
      method: request.method, headers: request.headers, ...(request.body ? { body: request.body, duplex: "half" } : {}),
    }); } });
  const request = (path, init) => receiver.fetch(new Request(origin + path, init));
  const put = (body, auth = authorization) => request("/" + encodeURIComponent(body.name), {
    method: "PUT", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { receiver, request, put, bucket, native, nativeCalls };
}
const writes = bucket => bucket.calls.filter(call => call.method === "put");

test("native authentication and unchanged private-name policy receive complete prepared npm bytes in R2", async t => {
  const f = await fixture(t), p = publication();
  assert.equal((await f.native.put(p.body.name, p.body)).status, 201, "same native principal has actual private publishing authority");
  const received = await f.put(p.body); assert.equal(received.status, 201, await received.clone().text());
  const report = await received.json(); assert.equal(report.custody.state, "retired");
  assert.deepEqual(f.bucket.objects.get(archiveKey("1.0.0")).bytes, p.bytes);
  const manifest = await (await f.request("/" + name + "/1.0.0")).json();
  const nativeManifest = await (await f.native.request("/" + name + "/1.0.0")).json();
  assert.deepEqual(manifest, nativeManifest, "complete manifest and authenticated publisher match the original native contract");
  assert.deepEqual(manifest._npmUser, { name: "fixture" });
  assert.equal(f.bucket.objects.has(custodyKey("1.0.0")), false);
  assert.deepEqual(f.nativeCalls, [{ method: "GET", url: origin + "/-/whoami", redirect: "manual" }], "publication does not write the native shelf");
  assert.equal(writes(f.bucket).length, 3, "input, immutable archive and conditional metadata only");
});

test("caller attribution cannot spoof the authenticated publisher or replace an immutable version", async t => {
  const f = await fixture(t), p = publication();
  p.body.versions["1.0.0"]._npmUser = { name: "claimed-other-publisher", email: "untrusted@example.invalid" };
  assert.equal((await f.put(p.body)).status, 201);
  const manifest = await (await f.request("/" + name + "/1.0.0")).json();
  assert.deepEqual(manifest, { ...p.body.versions["1.0.0"], _npmUser: { name: "fixture" } });
  const before = writes(f.bucket).length;
  assert.equal((await f.put(p.body, "Bearer fixture-r2-authority")).status, 409, "another authenticated principal cannot replace publisher attribution");
  assert.equal(writes(f.bucket).length, before);
  assert.deepEqual(await (await f.request("/" + name + "/1.0.0")).json(), manifest);
});

test("alternate leaf attachment and existing Bearer authority use the same receiver", async t => {
  const f = await fixture(t), p = publication();
  const [key] = Object.keys(p.body._attachments);
  p.body._attachments["r2-example-1.0.0.tgz"] = p.body._attachments[key]; delete p.body._attachments[key];
  p.body.versions["1.0.0"]._npmUser = { name: "client-claimed-publisher" };
  const reply = await f.put(p.body, "Bearer fixture-r2-authority");
  assert.equal(reply.status, 201, await reply.clone().text()); assert.deepEqual(f.nativeCalls, []);
  const manifest = await (await f.request("/" + name + "/latest")).json();
  assert.equal(manifest.gitHead, "1".repeat(40));
  assert.deepEqual(manifest._npmUser, { name: "existing-r2-publisher" });
});

test("existing versions/tags survive and exact complete duplicates perform no publication or custody write", async t => {
  const f = await fixture(t), first = publication(), next = publication("1.1.0");
  assert.equal((await f.put(first.body)).status, 201);
  next.body["dist-tags"] = { dev: "1.1.0" };
  assert.equal((await f.put(next.body)).status, 201);
  const before = writes(f.bucket).length, duplicate = await f.put(next.body);
  assert.equal(duplicate.status, 200); assert.equal(writes(f.bucket).length, before);
  const doc = await (await f.request("/" + name)).json();
  assert.deepEqual(Object.keys(doc.versions).sort(), ["1.0.0", "1.1.0"]);
  assert.deepEqual(doc["dist-tags"], { latest: "1.0.0", dev: "1.1.0" });
  assert.deepEqual(await (await f.request("/-/package/" + name + "/dist-tags")).json(), doc["dist-tags"]);
  const cached = await f.request("/" + name, { headers: { "if-none-match": (await f.request("/" + name)).headers.get("etag") } });
  assert.equal(cached.status, 304);
});

for (const repository of [undefined, { type: "git", url: "https://gitlab.com/fixture/information.git" }])
test(`R2 npm receiving preserves data without a GitHub source: ${JSON.stringify(repository)}`, async t => {
  const f = await fixture(t), p = publication("1.0.0", { repository });
  if (repository === undefined) delete p.body.versions["1.0.0"].repository;
  assert.equal((await f.put(p.body)).status, 201);
  const manifest = await (await f.request("/" + name + "/1.0.0")).json();
  assert.deepEqual(manifest.repository, repository);
  assert.deepEqual(Buffer.from(await (await f.request(new URL(manifest.dist.tarball).pathname)).arrayBuffer()), p.bytes);
});

test("identity does not grant a non-house name; unknown credentials never acquire input custody", async t => {
  const f = await fixture(t), p = publication();
  assert.equal((await f.put(p.body, "Basic " + Buffer.from("not-a-publisher:wrong").toString("base64"))).status, 401);
  const publicBody = publishBody(packagedVersion("public-fixture", "1.0.0"), { origin });
  assert.equal((await f.native.put(publicBody.name, publicBody)).status, 403);
  assert.equal((await f.put(publicBody)).status, 403);
  assert.equal(writes(f.bucket).length, 0);
});

test("bad wire, SRI, archive identity, missing export and inflated archive refuse before custody", async t => {
  const f = await fixture(t);
  for (const mutate of [
    body => { Object.values(body._attachments)[0].data = "!not-base64"; },
    body => { Object.values(body._attachments)[0].length++; },
    body => { body.versions["1.0.0"].dist.integrity = "sha512-bad"; },
    body => { body.versions["1.0.0"].name = "@registry-fixture/another"; },
  ]) {
    const p = publication(); mutate(p.body);
    assert.equal((await f.put(p.body)).status, 400);
  }
  const absent = publication("1.0.0", { exports: "./not-shipped.mjs" });
  const gate = await f.put(absent.body); assert.equal(gate.status, 400);
  assert.ok((await gate.json()).violations.some(item => item.kind === "export-target"));
  const limited = await fixture(t, { config: { maxUnpackedBytes: 1024 } });
  assert.equal((await limited.put(publication().body)).status, 400);
  assert.equal(writes(f.bucket).length, 0); assert.equal(writes(limited.bucket).length, 0);
});

test("house dependency gate reads canonical R2 instead of native origin", async t => {
  const f = await fixture(t);
  const supplier = publication("1.0.0", { name: "@registry-fixture/supplier" });
  const supplierBytes = packagedVersion("@registry-fixture/supplier", "1.0.0");
  const supplierBody = publishBody(supplierBytes, { origin });
  assert.equal((await f.put(supplierBody)).status, 201);
  const user = packagedVersion(name, "1.0.0", { manifest: { dependencies: { "@registry-fixture/supplier": "1.0.0" } },
    files: { "index.mjs": 'import "@registry-fixture/supplier"; export const loaded = true;\n' } });
  assert.equal((await f.put(publishBody(user, { origin }))).status, 201);
  assert.ok(f.nativeCalls.every(call => call.url.endsWith("/-/whoami")), "no origin metadata/supplier request");
});

test("immutable conflicts preserve both advertised and unadvertised original data", async t => {
  const f = await fixture(t), p = publication();
  f.bucket.seed(archiveKey("1.0.0"), "different original archive");
  const reply = await f.put(p.body); assert.equal(reply.status, 409);
  assert.equal(f.bucket.objects.get(archiveKey("1.0.0")).bytes.toString(), "different original archive");
  assert.deepEqual(f.bucket.objects.get(custodyKey("1.0.0")).bytes, Buffer.from(JSON.stringify(p.body)));
  assert.equal(f.bucket.objects.has(indexKey), false);
});

test("metadata CAS miss retains exact input/archive and never retries or overwrites another version", async t => {
  const f = await fixture(t), p = publication();
  let injected = false;
  f.bucket.beforePut = async key => {
    if (key === indexKey && !injected) { injected = true; f.bucket.seed(indexKey, JSON.stringify({ name, versions: { "0.9.0": { name, version: "0.9.0" } }, "dist-tags": { old: "0.9.0" } })); }
  };
  const reply = await f.put(p.body); assert.equal(reply.status, 409);
  assert.deepEqual(f.bucket.objects.get(custodyKey("1.0.0")).bytes, Buffer.from(JSON.stringify(p.body)));
  assert.deepEqual(Object.keys(JSON.parse(f.bucket.objects.get(indexKey).bytes).versions), ["0.9.0"]);
  assert.equal(writes(f.bucket).filter(call => call.key === indexKey).length, 1);
  assert.equal((await f.put(p.body)).status, 409, "held original input cannot authorize a fresh write");
  assert.equal(writes(f.bucket).filter(call => call.key === indexKey).length, 1);
});

test("unknown write effects retain accountable input and return 502 without a retry instruction", async t => {
  const f = await fixture(t), p = publication();
  f.bucket.afterPut = async key => { if (key === archiveKey("1.0.0")) throw Error("transport returned no terminal effect"); };
  const reply = await f.put(p.body); assert.equal(reply.status, 502); assert.equal(reply.headers.get("retry-after"), null);
  const result = await reply.json(); assert.equal(result.effectsUnknown, true); assert.equal(result.custody.state, "retained");
  assert.deepEqual(f.bucket.objects.get(custodyKey("1.0.0")).bytes, Buffer.from(JSON.stringify(p.body)));
  assert.equal(f.bucket.objects.has(archiveKey("1.0.0")), true);
  assert.equal(f.bucket.objects.has(indexKey), false);
});

test("delayed cleanup cannot delete another operation or cause same-version custody reuse", async t => {
  const f = await fixture(t), p = publication();
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let firstDelete = true;
  f.bucket.beforeDelete = async key => { if (key === custodyKey("1.0.0") && firstDelete) { firstDelete = false; entered(); await new Promise(resolve => { release = resolve; }); } };
  const first = f.put(p.body); await enteredPromise;
  const before = writes(f.bucket).length;
  assert.equal((await f.put(p.body)).status, 200);
  const changed = publication("1.0.0", { description: "conflicting immutable manifest" });
  assert.equal((await f.put(changed.body)).status, 409);
  assert.equal(writes(f.bucket).length, before, "published versions never allocate/reuse a cleanup key");
  release(); assert.equal((await first).status, 201);
  assert.equal(f.bucket.objects.has(custodyKey("1.0.0")), false);
});

test("received publication reports retained cleanup separately", async t => {
  const f = await fixture(t), p = publication();
  f.bucket.beforeDelete = async () => { throw Error("cleanup not received"); };
  const reply = await f.put(p.body); assert.equal(reply.status, 201);
  const report = await reply.json(); assert.equal(report.custody.state, "retained"); assert.equal(report.effectsUnknown, false);
  assert.equal((await f.request("/" + name + "/1.0.0")).status, 200);
  assert.equal(f.bucket.objects.has(custodyKey("1.0.0")), true);
});

test("custody namespace/raw writes and stale native house operations cannot bypass the R2 receiver", async t => {
  const f = await fixture(t), p = publication();
  for (const path of ["/-/publication-inputs/" + name + "/1.0.0.json", "/%2d/publication-inputs/a", "/-/publication-inputs"]) {
    for (const method of ["GET", "HEAD", "PUT"]) assert.equal((await f.request(path, { method })).status, 404);
  }
  assert.equal((await f.request("/" + archiveKey("1.0.0"), { method: "PUT", headers: { authorization }, body: p.bytes })).status, 405);
  assert.equal((await f.request("/-/package/" + name + "/dist-tags/dev", { method: "PUT", body: '"1.0.0"' })).status, 405);
  assert.equal((await f.request("/-/v1/search?text=r2-example")).status, 503);
  assert.equal(writes(f.bucket).length, 0);
});

test("generic non-house metadata is the public registry's; audit keeps the native house-inventory policy", async t => {
  const upstreamCalls = [], publicCalls = [];
  const document = { name: "external-fixture", versions: { "1.0.0": { name: "external-fixture", version: "1.0.0", dist: { tarball: "https://registry.npmjs.org/external-fixture/-/external-fixture-1.0.0.tgz" } } }, "dist-tags": { latest: "1.0.0" } };
  const f = await fixture(t, {
    uplinkFetch: async request => { publicCalls.push(request.url); return Response.json(document); },
    nativeOptions: { fetch: async (url, options = {}) => {
      upstreamCalls.push({ url: String(url), body: options.body && JSON.parse(options.body) });
      return Response.json({});
    } } });
  const metadata = await f.request("/external-fixture");
  assert.equal(metadata.status, 200); assert.match(metadata.headers.get("content-type"), /application\/json/);
  const served = await metadata.json();
  assert.equal(served.name, "external-fixture");
  assert.equal(served.versions["1.0.0"].dist.tarball, origin + "/external-fixture/-/external-fixture-1.0.0.tgz");
  assert.deepEqual(publicCalls, ["https://registry.npmjs.org/external-fixture"]);
  assert.deepEqual(f.nativeCalls, [], "a public read never reaches the native origin");
  const audit = await f.request("/-/npm/v1/security/advisories/bulk", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ "@registry-fixture/private": ["1.0.0"], "external-fixture": ["1.0.0"] }) });
  assert.equal(audit.status, 200);
  assert.ok(upstreamCalls.some(call => call.body && !Object.hasOwn(call.body, "@registry-fixture/private")));
  assert.equal(writes(f.bucket).length, 0);
});

test("a received duplicate reconciles its exact original input after an unreceived metadata effect without republishing", async t => {
  const f = await fixture(t), p = publication();
  let once = true;
  f.bucket.afterPut = async key => { if (key === indexKey && once) { once = false; throw Error("metadata effect not returned"); } };
  const unknown = await f.put(p.body); assert.equal(unknown.status, 502);
  assert.equal(f.bucket.objects.has(custodyKey("1.0.0")), true);
  const before = writes(f.bucket).length;
  const received = await f.put(p.body); assert.equal(received.status, 200);
  assert.equal((await received.json()).custody.state, "retired");
  assert.equal(writes(f.bucket).length, before, "receiving/retirement must not replay a publication");
  assert.equal(f.bucket.objects.has(custodyKey("1.0.0")), false);
});

test("actual input bytes must be received before archive or metadata effects", async t => {
  const f = await fixture(t), p = publication();
  f.bucket.afterPut = async key => {
    if (key === custodyKey("1.0.0")) f.bucket.seed(key, "another input", { customMetadata: { publisher: "fixture" } });
  };
  const reply = await f.put(p.body); assert.equal(reply.status, 502);
  assert.equal((await reply.json()).custody.state, "claim-unreceived");
  assert.deepEqual(writes(f.bucket).map(call => call.key), [custodyKey("1.0.0")]);
  assert.equal(f.bucket.objects.has(archiveKey("1.0.0")), false);
});

test("native login/token authentication remains delegated while a non-house tarball is the public registry's, redirects kept manual", async t => {
  const publicCalls = [];
  const f = await fixture(t, { uplinkFetch: async request => {
    publicCalls.push({ url: request.url, redirect: request.redirect, authorization: request.headers.get("authorization") });
    return new Response(null, { status: 302, headers: { location: "https://registry.npmjs.org/elsewhere.tgz" } });
  } });
  const login = await f.request("/-/user/org.couchdb.user:fixture", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "fixture", password: "local-disposable-test-only" }),
  });
  assert.equal(login.status, 201); assert.equal(login.headers.get("cache-control"), "no-store");
  const token = (await login.json()).token;
  const p = publication(); assert.equal((await f.put(p.body, "Bearer " + token)).status, 201);
  const artifact = await f.request("/external-fixture/-/external-fixture-1.0.0.tgz", { headers: { authorization: "Bearer " + token } });
  assert.equal(artifact.status, 302, "the public registry's status passes through");
  assert.equal(artifact.headers.get("location"), origin + "/elsewhere.tgz");
  assert.deepEqual(publicCalls, [{ url: "https://registry.npmjs.org/external-fixture/-/external-fixture-1.0.0.tgz", redirect: "manual", authorization: null }]);
  assert.ok(f.nativeCalls.every(call => call.url.includes("/-/")), "no native public read");
});

test("native authenticated redirects are refused without following credentials or acquiring input custody", async () => {
  const bucket = new MemoryR2(), calls = [];
  const receiver = createR2Registry({ bucket, configuration: configuration(), nativeFetch: async request => {
    assert.equal(request.redirect, "manual", "Cloudflare Request cannot construct redirect:error");
    calls.push(request.url);
    return new Response("redirect", { status: 302, headers: { location: "https://another-authority.invalid/receive" } });
  } });
  const who = await receiver.fetch(new Request(origin + "/-/whoami", { headers: { authorization } }));
  assert.equal(who.status, 503);
  const reply = await receiver.fetch(new Request(origin + "/" + encodeURIComponent(name), {
    method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(publication().body),
  }));
  assert.equal(reply.status, 503);
  assert.deepEqual(calls, [origin + "/-/whoami", origin + "/-/whoami"]);
  assert.equal(writes(bucket).length, 0);
});

const inputDigest = body => createHash("sha256").update(JSON.stringify(body)).digest("hex");
const resume = (f, body, { auth = authorization, inputSha256 = inputDigest(body), version = Object.keys(body.versions)[0] } = {}) =>
  f.request("/-/publication-inputs/" + encodeURIComponent(body.name) + "/" + version + "/resume", {
    method: "POST", headers: { authorization: auth, "content-type": "application/json", "x-561-input-sha256": inputSha256 },
    body: JSON.stringify(body),
  });

test("original owner continuation admits exact absent input through the unchanged gate and atomic claim", async t => {
  const f = await fixture(t), p = publication();
  const received = await resume(f, p.body);
  assert.equal(received.status, 201, await received.clone().text());
  assert.deepEqual(f.bucket.objects.get(archiveKey("1.0.0")).bytes, p.bytes);
  assert.equal(writes(f.bucket).length, 3);
  assert.equal(f.bucket.objects.has(custodyKey("1.0.0")), false);
  const before = writes(f.bucket).length;
  const duplicate = await resume(f, p.body);
  assert.equal(duplicate.status, 200, "a completed continuation only receives its existing effects");
  assert.equal((await duplicate.json()).custody.state, "retired", "explicit continuation positively receives terminal custody");
  assert.equal(writes(f.bucket).length, before);
});

test("owner continuation resumes exact retained bytes without replacing input or immutable archive", async t => {
  class Interrupted extends MemoryR2 {
    fail = true;
    async put(key, value, options) {
      if (key === indexKey && this.fail) { this.fail = false; throw Error("interrupted metadata write"); }
      return super.put(key, value, options);
    }
  }
  const f = await fixture(t, { bucket: new Interrupted() }), p = publication();
  const first = await f.put(p.body); assert.equal(first.status, 502);
  assert.equal((await first.json()).effectsUnknown, true);
  const retained = Buffer.from(f.bucket.objects.get(custodyKey("1.0.0")).bytes);
  const before = writes(f.bucket).length;
  assert.equal((await f.put(p.body)).status, 409, "ordinary publication cannot replace a pending original input");
  const received = await resume(f, p.body);
  assert.equal(received.status, 201, await received.clone().text());
  assert.equal(writes(f.bucket).length, before + 1, "only the missing conditional metadata write is made");
  assert.equal(inputDigest(p.body), createHash("sha256").update(retained).digest("hex"));
  assert.deepEqual(f.bucket.objects.get(archiveKey("1.0.0")).bytes, p.bytes);
});

test("continuation refuses another publisher or other retained input without publication writes", async t => {
  for (const otherPublisher of [false, true]) {
    const f = await fixture(t), p = publication(), original = Buffer.from(JSON.stringify(p.body));
    await f.bucket.put(custodyKey("1.0.0"), original, { customMetadata: {
      publisher: otherPublisher ? "another-publisher" : "fixture", inputSha256: inputDigest(p.body),
    } });
    if (!otherPublisher) p.body.description = "different original bytes";
    const before = writes(f.bucket).length, received = await resume(f, p.body);
    assert.equal(received.status, 409, await received.clone().text());
    assert.equal(writes(f.bucket).length, before);
    assert.deepEqual(f.bucket.objects.get(custodyKey("1.0.0")).bytes, original);
    assert.equal(f.bucket.objects.has(indexKey), false);
  }
});

test("continuation requires original hash and version and retains publication validation", async t => {
  const f = await fixture(t), p = publication();
  for (const selection of [{ inputSha256: "a".repeat(64) }, { version: "9.9.9" }]) {
    const received = await resume(f, p.body, selection); assert.equal(received.status, 400);
    assert.equal(writes(f.bucket).length, 0);
  }
  const invalid = publication("1.0.0", { exports: { ".": "./unshipped.mjs" } });
  const refused = await resume(f, invalid.body); assert.equal(refused.status, 400);
  assert.equal(writes(f.bucket).length, 0, "owner continuation never bypasses the gate");
});

test("a refused continuation preserves and reports its original held server custody", async t => {
  const f = await fixture(t), p = publication("1.0.0", { exports: { ".": "./unshipped.mjs" } });
  const original = Buffer.from(JSON.stringify(p.body));
  await f.bucket.put(custodyKey("1.0.0"), original, { customMetadata: { publisher: "fixture", inputSha256: inputDigest(p.body) } });
  const before = writes(f.bucket).length, received = await resume(f, p.body);
  assert.equal(received.status, 400);
  const result = await received.json();
  assert.equal(result.custody.state, "retained");
  assert.equal(result.custody.inputSha256, inputDigest(p.body));
  assert.equal(writes(f.bucket).length, before);
  assert.deepEqual(f.bucket.objects.get(custodyKey("1.0.0")).bytes, original);
});

test("competing exact continuations preserve one immutable archive and one metadata commit", async t => {
  const f = await fixture(t), p = publication(), original = Buffer.from(JSON.stringify(p.body));
  await f.bucket.put(custodyKey("1.0.0"), original, { customMetadata: { publisher: "fixture", inputSha256: inputDigest(p.body) } });
  const results = await Promise.all([resume(f, p.body), resume(f, p.body)]);
  assert.ok(results.some(r => r.status === 201));
  assert.ok(results.every(r => [200, 201, 409].includes(r.status)));
  assert.equal(writes(f.bucket).filter(call => call.key === indexKey).length, 1);
  assert.deepEqual(f.bucket.objects.get(archiveKey("1.0.0")).bytes, p.bytes);
  assert.equal((await resume(f, p.body)).status, 200);
});

test("a packument nothing projects is served as its stored bytes, with its stored etag and 304", async t => {
  const f = await fixture(t), p = publication();
  assert.equal((await f.put(p.body)).status, 201);
  const stored = f.bucket.objects.get(indexKey);
  const served = await f.request("/" + encodeURIComponent(name));
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from(stored.bytes), "byte-identical to what publication wrote");
  assert.equal(served.headers.get("etag"), '"' + stored.etag + '"');
  assert.equal(served.headers.get("content-length"), String(stored.bytes.length));
  const again = await f.request("/" + encodeURIComponent(name), { headers: { "if-none-match": '"' + stored.etag + '"' } });
  assert.equal(again.status, 304);
  const head = await f.request("/" + encodeURIComponent(name), { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
});
