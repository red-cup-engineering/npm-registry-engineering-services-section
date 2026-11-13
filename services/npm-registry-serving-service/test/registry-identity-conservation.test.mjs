import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "@red-cup-engineering/json-engineering-services-section/canonical-json";
import worker, { createR2Registry } from "../src/r2-registry.mjs";
import { registryFixture, authorization, publishBody } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { MemoryR2 } from "./support/r2.mjs";

const origin = "https://registry.invalid", name = "@registry-fixture/identity", version = "0.2.5-dev.0";
const configuration = { origin, privateScopes: ["@registry-fixture"], privateNames: [], nativePublisherPolicy: "native-authenticated-house-publishers-v1" };
const evidence = { recordSha256: "a".repeat(64), work: "https://github.com/561-group/561-group-bare-cedar-fog-services-section/issues/599" };
const observed = (manifest, authority) => ({ authority, gitHead: manifest.gitHead ?? null, integrity: manifest.dist.integrity,
  tarball: manifest.dist.tarball, manifestSha256: createHash("sha256").update(canonicalJson(manifest)).digest("hex") });
const bodyOf = (selected = version, gitHead = "1".repeat(40), extra = {}) => {
  const bytes = packagedVersion(name, selected, { manifest: { gitHead, ...extra } });
  return { bytes, body: publishBody(bytes, { origin }) };
};
async function setup(t) {
  const native = await registryFixture(t, { origin }), bucket = new MemoryR2();
  const create = (policy, restrictions = {}) => createR2Registry({ bucket, configuration: { ...configuration, ...(policy ? { identityConservation: policy } : {}), ...restrictions },
    publishToken: "fixture-r2-authority",
    nativeFetch: request => native.request(new URL(request.url).pathname, { method: request.method, headers: request.headers }) });
  const request = (receiver, path, init) => receiver.fetch(new Request(origin + path, init));
  const put = (receiver, body, auth = authorization) => request(receiver, "/" + encodeURIComponent(body.name), {
    method: "PUT", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { native, bucket, create, request, put };
}
async function conflictFixture(t) {
  const f = await setup(t), raw = f.create(), canonical = bodyOf(), nativeProduct = bodyOf(version, "2".repeat(40));
  assert.equal((await f.put(raw, canonical.body)).status, 201);
  assert.equal((await f.native.put(name, nativeProduct.body)).status, 201);
  const nativeManifest = await (await f.native.request("/" + name + "/" + version)).json();
  const rawDocument = JSON.parse(f.bucket.objects.get(name + "/index.json").bytes);
  const conflict = { name, version, evidence, identities: [observed(nativeManifest, "native"), observed(rawDocument.versions[version], "canonical-r2")] };
  const policy = { version: 1, conflicts: [conflict], reservations: [] };
  return { ...f, raw, canonical, nativeProduct, rawDocument, conflict, policy, receiver: f.create(policy) };
}

test("both real archive identities survive while exact version, tag and archive GET/HEAD are quarantined", async t => {
  const f = await conflictFixture(t), before = [...f.bucket.objects].map(([key, value]) => [key, { ...value, bytes: Buffer.from(value.bytes), customMetadata: structuredClone(value.customMetadata), httpMetadata: structuredClone(value.httpMetadata) }]);
  const paths = ["/" + name + "/" + version, "/" + name + "/latest", new URL(f.canonical.body.versions[version].dist.tarball).pathname,
    "/-/package/" + name + "/dist-tags/latest"];
  for (const method of ["GET", "HEAD"]) for (const path of paths) {
    const r = await f.request(f.receiver, path, { method }); assert.equal(r.status, 409, method + " " + path);
  }
  assert.deepEqual([...f.bucket.objects], before);
  assert.equal((await f.native.request("/" + name + "/" + version)).status, 200, "native original remains retained");
});

test("served packument projects conflicts with evidence and derived ETag without deleting durable versions/tags", async t => {
  const f = await conflictFixture(t), stable = bodyOf("0.2.4"); stable.body["dist-tags"] = { stable: "0.2.4" };
  assert.equal((await f.put(f.raw, stable.body)).status, 201);
  const original = Buffer.from(f.bucket.objects.get(name + "/index.json").bytes), rawEtag = '"' + f.bucket.objects.get(name + "/index.json").etag + '"';
  const r = await f.request(f.receiver, "/" + name), document = await r.json();
  assert.equal(Object.hasOwn(document.versions, version), false); assert.equal(document["dist-tags"].latest, undefined);
  assert.equal(document.time[version], undefined); assert.equal(document["dist-tags"].stable, "0.2.4");
  assert.deepEqual(document["x-561-registry-conflicts"][0].evidence, evidence);
  assert.notEqual(r.headers.get("etag"), rawEtag);
  assert.equal((await f.request(f.receiver, "/" + name, { headers: { "if-none-match": rawEtag } })).status, 200);
  assert.equal((await f.request(f.receiver, "/" + name, { headers: { "if-none-match": r.headers.get("etag") } })).status, 304);
  assert.equal((await f.request(f.receiver, "/" + name, { method: "HEAD" })).body, null);
  assert.deepEqual(f.bucket.objects.get(name + "/index.json").bytes, original);
  const stableArchive = await f.request(f.receiver, new URL(stable.body.versions["0.2.4"].dist.tarball).pathname);
  assert.equal(stableArchive.status, 200); assert.deepEqual(Buffer.from(await stableArchive.arrayBuffer()), stable.bytes);
});

test("conflicted PUT and exact duplicate refuse before metadata, custody or cleanup effects", async t => {
  const f = await conflictFixture(t), input = "-/publication-inputs/" + name + "/" + version + ".json";
  f.bucket.seed(input, "retained original uncertain input"); const before = f.bucket.calls.length;
  assert.equal((await f.put(f.receiver, f.canonical.body)).status, 409);
  assert.equal((await f.put(f.receiver, f.nativeProduct.body)).status, 409);
  assert.equal(f.bucket.calls.length, before); assert.equal(f.bucket.objects.get(input).bytes.toString(), "retained original uncertain input");
});

test("unaffected publication uses raw CAS and preserves quarantined durable originals", async t => {
  const f = await conflictFixture(t), next = bodyOf("0.2.5-dev.1"); next.body["dist-tags"] = { dev: "0.2.5-dev.1" };
  const originalVersion = structuredClone(f.rawDocument.versions[version]), originalArchive = Buffer.from(f.canonical.bytes);
  const reply = await f.put(f.receiver, next.body); assert.equal(reply.status, 201, await reply.clone().text());
  const raw = JSON.parse(f.bucket.objects.get(name + "/index.json").bytes);
  assert.deepEqual(raw.versions[version], originalVersion); assert.equal(raw["dist-tags"].latest, version);
  assert.equal(raw["dist-tags"].dev, "0.2.5-dev.1");
  assert.deepEqual(f.bucket.objects.get(name + "/-/identity-" + version + ".tgz").bytes, originalArchive);
  assert.equal(Object.hasOwn((await (await f.request(f.receiver, "/" + name)).json()).versions, version), false);
  const badTag = bodyOf("0.2.5-dev.2"); badTag.body["dist-tags"] = { dev: version };
  const before = f.bucket.calls.length; assert.equal((await f.put(f.receiver, badTag.body)).status, 409); assert.equal(f.bucket.calls.length, before);
});

test("the actual shared publication gate cannot admit a quarantined supplier version", async t => {
  const f = await conflictFixture(t), consumer = "@registry-fixture/consumer";
  const bytes = packagedVersion(consumer, "1.0.0", { manifest: { dependencies: { [name]: version } } });
  const body = publishBody(bytes, { origin }), before = f.bucket.calls.filter(x => x.method === "put").length;
  const r = await f.put(f.receiver, body); assert.equal(r.status, 400, await r.clone().text());
  assert.ok((await r.json()).violations.some(x => x.kind === "dependency"));
  assert.equal(f.bucket.calls.filter(x => x.method === "put").length, before);
});

test("reserved native-only identity requires full observed manifest/SRI/source and ordinary authentication", async t => {
  const f = await setup(t), product = bodyOf("0.2.5-dev.42");
  assert.equal((await f.native.put(name, product.body)).status, 201);
  const native = await (await f.native.request("/" + name + "/0.2.5-dev.42")).json();
  const reservation = { name, version: "0.2.5-dev.42", evidence, identity: observed(native, "native") };
  const receiver = f.create({ version: 1, conflicts: [], reservations: [reservation] });
  const exact = publishBody(product.bytes, { origin, manifest: native });
  for (const mutate of [m => { m.description = "changed"; }, m => { m.gitHead = "3".repeat(40); }, m => { m.dist.integrity = "sha512-" + Buffer.alloc(64, 4).toString("base64"); }, m => { m._npmUser = { name: "forged-publisher" }; }]) {
    const changed = structuredClone(exact); mutate(changed.versions[reservation.version]); const before = f.bucket.calls.length;
    assert.equal((await f.put(receiver, changed)).status, 409); assert.equal(f.bucket.calls.length, before);
  }
  assert.equal((await f.put(receiver, exact, "Basic " + Buffer.from("fixture:incorrect").toString("base64"))).status, 401);
  // JSON field order is not a new identity; the original Data canonicalizer receives it.
  exact.versions[reservation.version] = Object.fromEntries(Object.entries(exact.versions[reservation.version]).reverse());
  const r = await f.put(receiver, exact); assert.equal(r.status, 201, await r.clone().text());
  assert.deepEqual(await (await f.request(receiver, "/" + name + "/" + reservation.version)).json(), native);
  const before = f.bucket.calls.filter(call => call.method === "put").length;
  const duplicate = await f.put(receiver, exact, "Bearer fixture-r2-authority");
  assert.equal(duplicate.status, 200, "authenticated receiving does not rewrite committed historical publisher attribution");
  assert.equal(f.bucket.calls.filter(call => call.method === "put").length, before);
  assert.deepEqual(await (await f.request(receiver, "/" + name + "/" + reservation.version)).json(), native);
});

test("a reservation has no authority to bypass the original archive static gate", async t => {
  const f = await setup(t), product = bodyOf("0.2.5-dev.42", "1".repeat(40), { exports: "./missing.mjs" });
  const manifest = product.body.versions["0.2.5-dev.42"], receiver = f.create({ version: 1, conflicts: [], reservations: [
    { name, version: manifest.version, evidence, identity: observed(manifest, "native") },
  ] });
  const r = await f.put(receiver, product.body); assert.equal(r.status, 400, await r.clone().text());
  assert.ok((await r.json()).violations.some(x => x.kind === "export-target"));
  assert.equal(f.bucket.calls.some(x => x.method === "put"), false);
});

test("incomplete, overlapping and forged conservation observations fail configuration before storage", async t => {
  const f = await conflictFixture(t);
  for (const mutate of [p => { p.conflicts[0].identities.pop(); }, p => { p.conflicts[0].identities[0].gitHead = "unknown"; },
    p => { p.publishAllowed = true; }, p => { p.reservations.push({ name, version, evidence, identity: p.conflicts[0].identities[0] }); }]) {
    const changed = structuredClone(f.policy); mutate(changed); const before = f.bucket.calls.length;
    assert.throws(() => f.create(changed), TypeError); assert.equal(f.bucket.calls.length, before);
  }
});

test("legacy conflict with absent source is held by its full original manifest and archive commitments", async t => {
  const f = await conflictFixture(t), document = structuredClone(f.rawDocument);
  delete document.versions[version].gitHead;
  f.bucket.seed(name + "/index.json", JSON.stringify(document));
  const policy = structuredClone(f.policy);
  policy.conflicts[0].identities[1] = observed(document.versions[version], "canonical-r2");
  assert.equal(policy.conflicts[0].identities[1].gitHead, null);
  const receiver = f.create(policy), before = Buffer.from(f.bucket.objects.get(name + "/index.json").bytes);
  const request = () => new Request(origin + "/" + name);
  const projected = await (await receiver.fetch(request())).json();
  assert.equal(Object.hasOwn(projected.versions, version), false);
  assert.equal((await f.request(receiver, "/" + name + "/" + version)).status, 409);
  assert.deepEqual(f.bucket.objects.get(name + "/index.json").bytes, before);
  const drifted = structuredClone(document); drifted.versions[version].description = "unreceived drift";
  f.bucket.seed(name + "/index.json", JSON.stringify(drifted));
  assert.equal((await receiver.fetch(request())).status, 502, "null source cannot waive full-manifest equality");
  assert.throws(() => f.create({ version: 1, conflicts: [], reservations: [
    { name, version, evidence, identity: { ...policy.conflicts[0].identities[1], authority: "native" } },
  ] }), /original source\/authority/);
});

test("the real Worker adapter receives separate typed arrays and refuses partial or mixed policy", async t => {
  const f = await conflictFixture(t), env = { R: f.bucket, REGISTRY_CONFIGURATION: JSON.stringify(configuration),
    REGISTRY_IDENTITY_CONFLICTS: JSON.stringify(f.policy.conflicts), REGISTRY_IDENTITY_RESERVATIONS: "[]" };
  const request = () => new Request(origin + "/" + name);
  assert.equal(Object.hasOwn((await (await worker.fetch(request(), env)).json()).versions, version), false);
  assert.equal((await worker.fetch(new Request(origin + "/" + name + "/" + version), env)).status, 409);
  const before = f.bucket.calls.length;
  assert.throws(() => worker.fetch(request(), { ...env, REGISTRY_IDENTITY_RESERVATIONS: undefined }), /both arrays/);
  assert.throws(() => worker.fetch(request(), { ...env, REGISTRY_CONFIGURATION: JSON.stringify({ ...configuration, identityConservation: f.policy }) }), /no embedded policy/);
  assert.throws(() => worker.fetch(request(), { ...env, REGISTRY_IDENTITY_CONFLICTS: "{}" }), /typed conflict/);
  assert.equal(f.bucket.calls.length, before);
});

test("an operator conservation hold refuses new and duplicate ordinary publications before storage or cleanup", async t => {
  const f = await setup(t), product = bodyOf(), raw = f.create();
  assert.equal((await f.put(raw, product.body)).status, 201);
  const key = "-/publication-inputs/" + name + "/" + version + ".json";
  f.bucket.seed(key, "unresolved original input");
  const publicationHold = { type: "RegistryIdentityConservationHold", recordSha256: evidence.recordSha256, work: evidence.work };
  const held = f.create(undefined, { publicationHold }), before = f.bucket.calls.length;
  for (const body of [product.body, bodyOf("0.2.5-dev.9").body]) {
    const r = await f.put(held, body); assert.equal(r.status, 423);
    const refusal = await r.json(); assert.deepEqual(refusal.publicationHold, publicationHold);
    assert.equal(refusal.effectsUnknown, false); assert.equal(refusal.custody.state, "not-allocated");
    assert.equal(r.headers.get("retry-after"), null);
  }
  assert.equal(f.bucket.calls.length, before);
  assert.equal(f.bucket.objects.get(key).bytes.toString(), "unresolved original input");
  assert.equal((await f.request(held, "/" + name + "/" + version)).status, 200, "retained reads stay available");
  assert.equal((await f.put(held, product.body, "Basic " + Buffer.from("fixture:incorrect").toString("base64"))).status, 401);
});

test("a conservation hold has no exact-reservation, metadata or tag exception", async t => {
  const f = await setup(t), product = bodyOf("0.2.5-dev.42");
  assert.equal((await f.native.put(name, product.body)).status, 201);
  const manifest = await (await f.native.request("/" + name + "/0.2.5-dev.42")).json();
  const publicationHold = { type: "RegistryIdentityConservationHold", recordSha256: evidence.recordSha256, work: evidence.work };
  const policy = { version: 1, conflicts: [], reservations: [{ name, version: manifest.version, evidence, identity: observed(manifest, "native") }] };
  const held = f.create(policy, { publicationHold }), exact = publishBody(product.bytes, { origin, manifest });
  exact["dist-tags"] = {};
  const forged = structuredClone(exact); forged.versions[manifest.version].description = "forged native product";
  const tagChange = structuredClone(exact); tagChange["dist-tags"] = { latest: manifest.version };
  const metadataChange = { ...exact, description: "unrelated packument mutation" };
  for (const body of [exact, forged, tagChange, metadataChange]) {
    const reply = await f.put(held, body);
    assert.equal(reply.status, 423); assert.equal(f.bucket.calls.length, 0);
    assert.equal((await reply.json()).custody.state, "not-allocated");
  }
  assert.equal((await f.put(held, exact, "Basic " + Buffer.from("fixture:incorrect").toString("base64"))).status, 401);
  assert.equal(f.bucket.calls.length, 0);
});

test("retired scoped-release configuration refuses even null declarations before storage", async t => {
  const f = await setup(t);
  for (const conservationRelease of [null, undefined, {}, true, { type: "RegistryConservationRelease" }])
    assert.throws(() => f.create(undefined, { conservationRelease }), /conservationRelease is retired/);
  assert.equal(f.bucket.calls.length, 0);
});

test("invalid or permission-like conservation hold declarations refuse configuration", async t => {
  const f = await setup(t), hold = { type: "RegistryIdentityConservationHold", recordSha256: evidence.recordSha256, work: evidence.work };
  for (const publicationHold of [true, {}, { ...hold, allowPublication: true }, { ...hold, recordSha256: "unknown" }])
    assert.throws(() => f.create(undefined, { publicationHold }), /typed original conservation/);
  assert.equal(f.bucket.calls.length, 0);
});

test("the global hold precedes known conflict refusal without touching retained originals", async t => {
  const f = await conflictFixture(t);
  const publicationHold = { type: "RegistryIdentityConservationHold", recordSha256: evidence.recordSha256, work: evidence.work };
  const held = f.create(f.policy, { publicationHold }), before = f.bucket.calls.length;
  for (const body of [f.canonical.body, f.nativeProduct.body]) {
    const reply = await f.put(held, body); assert.equal(reply.status, 423);
    assert.equal((await reply.json()).custody.state, "not-allocated");
  }
  assert.equal(f.bucket.calls.length, before);
  assert.equal((await f.request(held, "/" + name + "/" + version)).status, 409, "the held read still exposes the original conflict");
});
