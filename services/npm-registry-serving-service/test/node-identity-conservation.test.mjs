import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@red-cup-engineering/json-engineering-services-section/canonical-json";
import { identityConservationOf, IDENTITY_CONSERVATION_RECORD } from "../src/application.mjs";
import { foldPackage } from "../src/projection.mjs";
import { bucketPeer, receivePeers } from "../src/peers.mjs";
import { createR2Registry } from "../src/r2-registry.mjs";
import { createNpmRegistry } from "../src/registry.mjs";
import { createPackageStore } from "../src/store.mjs";
import { registryFixture, authorization, publishBody } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { MemoryR2 } from "./support/r2.mjs";

// The node's quarantine of conflicting immutable identities, received against the canonical Worker's own
// (registry-identity-conservation.test.mjs): the same module, the same refusals, the same evidence.
const origin = "https://registry.invalid", name = "@registry-fixture/identity", version = "0.2.5-dev.0";
const file = "identity-0.2.5-dev.0.tgz", stableFile = "identity-0.2.4.tgz";
const evidence = { recordSha256: "a".repeat(64), work: "https://github.com/red-cup-engineering/npm-registry-serving-service/issues/17" };
const quarantinedBody = { error: "package version is quarantined for conflicting immutable identities" };
const workerConfiguration = { origin, privateScopes: ["@registry-fixture"], privateNames: [], nativePublisherPolicy: "native-authenticated-house-publishers-v1" };
const sha256 = value => createHash("sha256").update(value).digest("hex");
const observed = (manifest, authority) => ({ authority, gitHead: manifest.gitHead ?? null, integrity: manifest.dist.integrity,
  tarball: manifest.dist.tarball, manifestSha256: sha256(canonicalJson(manifest)) });
const product = (selected, gitHead, fields = {}) => packagedVersion(name, selected, { manifest: { gitHead, ...fields } });
const stable = product("0.2.4", "0".repeat(40), { description: "received stable product", keywords: ["received"] });
const bytesOf = async reply => Buffer.from(await reply.arrayBuffer());

/** Every file under a store with its bytes' digest: what "nothing stored changed" is checked against. */
async function storeSnapshot(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  return Promise.all(files.map(async path => [path, sha256(await readFile(path))]));
}

/** A node registry over an existing fixture's store, with the given conservation. */
function nodeOver(fixture, identityConservation, options = {}) {
  const registry = createNpmRegistry({ storage: fixture.storage, htpasswd: join(fixture.root, "htpasswd"), origin,
    privateScopes: ["@registry-fixture"], identityConservation, ...options });
  return (path, init) => registry.handle(new Request(origin + path, init));
}

/**
 * The canonical Worker and two nodes in the shape the incident has: canonical R2 holds one identity of
 * name@version, a native node holds the other, and the conflict record observes both from what each serves.
 */
async function conflictFixture(t, { withStable = true } = {}) {
  const native = await registryFixture(t, { origin }), bucket = new MemoryR2();
  const raw = createR2Registry({ bucket, configuration: workerConfiguration, publishToken: "fixture-r2-authority",
    nativeFetch: request => native.request(new URL(request.url).pathname, { method: request.method, headers: request.headers }) });
  const put = (receiver, body) => receiver.fetch(new Request(origin + "/" + encodeURIComponent(body.name), {
    method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const fields = { description: "quarantined product", keywords: ["quarantined"] };
  const canonical = product(version, "1".repeat(40), fields), nativeProduct = product(version, "2".repeat(40), fields);
  if (withStable) assert.equal((await put(raw, publishBody(stable, { origin, tag: "stable" }))).status, 201);
  assert.equal((await put(raw, publishBody(canonical, { origin }))).status, 201);
  if (withStable) assert.equal((await native.publish(stable, { tag: "stable" })).status, 201);
  assert.equal((await native.publish(nativeProduct)).status, 201);
  const nativeManifest = await (await native.request("/" + name + "/" + version)).json();
  const rawDocument = JSON.parse(bucket.objects.get(name + "/index.json").bytes);
  const conflict = { name, version, evidence, identities: [observed(nativeManifest, "native"), observed(rawDocument.versions[version], "canonical-r2")] };
  const policy = { version: 1, conflicts: [conflict], reservations: [] };
  const worker = createR2Registry({ bucket, configuration: { ...workerConfiguration, identityConservation: policy }, publishToken: "fixture-r2-authority",
    nativeFetch: request => native.request(new URL(request.url).pathname, { method: request.method, headers: request.headers }) });
  return { native, bucket, canonical, nativeProduct, conflict, policy, withStable, worker: (path, init) => worker.fetch(new Request(origin + path, init)) };
}

/** A node that received canonical R2's identity of the conflicting version before the quarantine was recorded. */
async function nodeHoldingCanonical(t, f) {
  const node = await registryFixture(t, { origin });
  const outcome = await receivePeers(createPackageStore({ storage: node.storage }), name, [bucketPeer({ name: "r2", bucket: f.bucket })], { origin, eager: () => true });
  assert.deepEqual(outcome.received.sort(), f.withStable ? ["0.2.4", version] : [version]);
  return node;
}

const quarantinedPaths = ["/" + name + "/" + version, "/" + name + "/latest", "/" + name + "/-/" + file, "/-/package/" + name + "/dist-tags/latest"];

for (const holding of ["canonical-r2", "native"]) {
  test(`a node holding the ${holding} identity refuses the quarantined version, its tag and its archive 409 as the Worker does, and changes nothing stored`, async t => {
    const f = await conflictFixture(t), held = holding === "native" ? f.native : await nodeHoldingCanonical(t, f);
    const node = nodeOver(held, f.policy), before = await storeSnapshot(held.storage);
    assert.equal((await held.request("/" + name + "/" + version)).status, 200, "without the record the node served its identity");
    for (const method of ["GET", "HEAD"]) for (const path of quarantinedPaths) {
      const [mine, worker] = [await node(path, { method }), await f.worker(path, { method })];
      assert.equal(mine.status, 409, `node ${method} ${path}`);
      assert.equal(worker.status, 409, `Worker ${method} ${path}`);
      if (method === "GET") assert.deepEqual(await mine.json(), await worker.json(), `the node's refusal is the Worker's: ${path}`);
    }
    assert.deepEqual(await (await node(quarantinedPaths[0])).json(), quarantinedBody);
    // Unaffected versions and tags stay served, on the node as on the Worker.
    assert.equal((await node("/" + name + "/0.2.4")).status, 200);
    assert.equal((await node("/" + name + "/stable")).status, 200);
    const archive = await node("/" + name + "/-/" + stableFile);
    assert.equal(archive.status, 200); assert.deepEqual(await bytesOf(archive), stable);
    assert.deepEqual(await (await node("/-/package/" + name + "/dist-tags")).json(), { stable: "0.2.4" });
    assert.deepEqual(await storeSnapshot(held.storage), before, "the quarantine writes and removes nothing");
    assert.equal((await held.request("/" + name + "/" + version)).status, 200, "the stored identity is retained");
  });

  test(`a node holding the ${holding} identity serves a packument without it, carrying both identities as the Worker does, with its own ETag`, async t => {
    const f = await conflictFixture(t), held = holding === "native" ? f.native : await nodeHoldingCanonical(t, f);
    const node = nodeOver(held, f.policy);
    const rawReply = await held.request("/" + encodeURIComponent(name)), rawEtag = rawReply.headers.get("etag");
    assert.ok(Object.hasOwn((await rawReply.json()).versions, version));
    const reply = await node("/" + encodeURIComponent(name)), document = await reply.json();
    const worker = await (await f.worker("/" + encodeURIComponent(name))).json();
    assert.equal(reply.status, 200);
    assert.equal(Object.hasOwn(document.versions, version), false);
    assert.equal(document["dist-tags"].latest, undefined); assert.equal(document["dist-tags"].stable, "0.2.4");
    assert.equal(document.time?.[version], undefined);
    assert.deepEqual(document["x-561-registry-conflicts"], [{ version, evidence, identities: f.conflict.identities }]);
    assert.deepEqual(document["x-561-registry-conflicts"], worker["x-561-registry-conflicts"], "the node's evidence is the Worker's");
    assert.deepEqual(Object.keys(document.versions), Object.keys(worker.versions));
    assert.notEqual(reply.headers.get("etag"), rawEtag);
    assert.equal((await node("/" + encodeURIComponent(name), { headers: { "if-none-match": rawEtag } })).status, 200);
    assert.equal((await node("/" + encodeURIComponent(name), { headers: { "if-none-match": reply.headers.get("etag") } })).status, 304);
    const install = await (await node("/" + encodeURIComponent(name), { headers: { accept: "application/vnd.npm.install-v1+json" } })).json();
    assert.deepEqual(Object.keys(install.versions), ["0.2.4"]);
    assert.deepEqual(install["dist-tags"], { stable: "0.2.4" });
    assert.deepEqual(install["x-561-registry-conflicts"], document["x-561-registry-conflicts"]);
  });
}

test("a node refuses to publish or tag a quarantined version, and still serves and publishes the rest", async t => {
  const f = await conflictFixture(t), node = nodeOver(f.native, f.policy), before = await storeSnapshot(f.native.storage);
  const fresh = await registryFixture(t, { origin }), empty = nodeOver(fresh, f.policy);
  const put = (request, body) => request("/" + encodeURIComponent(name), { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put(empty, publishBody(f.canonical, { origin }))).status, 409, "a node that holds neither identity does not take either");
  assert.equal((await put(empty, publishBody(f.nativeProduct, { origin }))).status, 409);
  assert.deepEqual(await readdir(fresh.storage).catch(() => []), [], "nothing was written for a refused publication");
  const tag = await node("/-/package/" + name + "/dist-tags/next", { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(version) });
  assert.equal(tag.status, 409);
  assert.deepEqual(await storeSnapshot(f.native.storage), before);
  const next = publishBody(product("0.2.5-dev.1", "3".repeat(40)), { origin, tag: "dev" });
  assert.equal((await put(node, next)).status, 201, "an unaffected version is published");
  // npm deprecate reads the packument the node serves (without the quarantined version) and PUTs it back whole.
  const document = await (await node("/" + encodeURIComponent(name))).json();
  document.versions["0.2.4"] = { ...document.versions["0.2.4"], deprecated: "use 0.2.5-dev.1" };
  const deprecated = await put(node, { name, versions: document.versions, "dist-tags": document["dist-tags"] });
  assert.equal(deprecated.status, 200, await deprecated.clone().text());
  assert.equal((await (await node("/" + name + "/0.2.4")).json()).deprecated, "use 0.2.5-dev.1");
  assert.equal((await f.native.request("/" + name + "/" + version)).status, 200, "the quarantined original is retained");
});

test("peer receiving never brings a quarantined version in, under either identity, nor a tag naming it", async t => {
  const f = await conflictFixture(t), node = await registryFixture(t, { origin }), store = createPackageStore({ storage: node.storage });
  const quarantined = selected => f.policy.conflicts.some(item => item.version === selected);
  const calls = [], peer = bucketPeer({ name: "r2", bucket: f.bucket });
  const counting = { name: peer.name, packument: peer.packument, artifact: (...args) => { calls.push(args[1]); return peer.artifact(...args); } };
  // A peer that is another node serves its own derived view of the quarantine; that view is never a fact to store.
  const document = JSON.parse(f.bucket.objects.get(name + "/index.json").bytes);
  f.bucket.seed(name + "/index.json", JSON.stringify({ ...document, "x-561-registry-conflicts": [{ version, evidence, identities: f.conflict.identities }] }));
  const outcome = await receivePeers(store, name, [counting], { origin, eager: () => true, quarantined });
  assert.deepEqual(outcome.received, ["0.2.4"]);
  assert.deepEqual(outcome.quarantined, [version]);
  assert.deepEqual(outcome.diverged, []);
  assert.deepEqual(calls, [stableFile], "the quarantined archive is never fetched");
  const state = foldPackage(name, (await store.read(name)).rows);
  assert.deepEqual([...state.versions.keys()], ["0.2.4"]);
  assert.equal(state.tags.get("latest"), undefined, "no tag naming the quarantined version is received");
  assert.equal(state.tags.get("stable"), "0.2.4");
  assert.equal(Object.hasOwn(state.fields, "x-561-registry-conflicts"), false);

  // A node that already holds the native identity is not offered the canonical one as a divergence, and keeps its own.
  const before = await storeSnapshot(f.native.storage);
  const held = await receivePeers(createPackageStore({ storage: f.native.storage }), name, [peer], { origin, eager: () => true, quarantined });
  assert.deepEqual(held.quarantined, [version]); assert.deepEqual(held.diverged, []); assert.deepEqual(held.received, []);
  assert.deepEqual(await storeSnapshot(f.native.storage), before);

  // Served through a node with peers: the first read receives from the peer and leaves the quarantined version out.
  const fresh = await registryFixture(t, { origin }), served = nodeOver(fresh, f.policy, { peers: [peer] });
  const packument = await (await served("/" + encodeURIComponent(name))).json();
  assert.deepEqual(Object.keys(packument.versions), ["0.2.4"]);
  assert.equal((await served("/" + name + "/-/" + file)).status, 409);
  const journal = foldPackage(name, (await createPackageStore({ storage: fresh.storage }).read(name)).rows);
  assert.deepEqual([...journal.versions.keys()], ["0.2.4"], "the node's store never held the quarantined version");
});

test("a node's identity conservation comes from the carrier the Worker's bindings come from, and fails closed", async t => {
  const record = JSON.parse(await readFile(IDENTITY_CONSERVATION_RECORD, "utf8"));
  assert.deepEqual(identityConservationOf({ origin: record.origin }), record.identityConservation, "the repository record is the default for its origin");
  assert.equal(identityConservationOf({ origin }), undefined, "another origin has no default conservation");
  assert.deepEqual(record.identityConservation.conflicts.map(item => item.name + "@" + item.version).sort(), [
    "@red-cup-engineering/computer-language-systems-engineering-services-section@0.1.4-dev.1",
    "@red-cup-engineering/npm-registry-serving-service@0.2.5-dev.0",
  ]);
  const scratch = await registryFixture(t, { origin });
  // The repository record is admitted by the Worker's own module on a node of the record's origin.
  const housed = createNpmRegistry({ storage: scratch.storage, origin: record.origin, privateScopes: ["@red-cup-engineering"],
    identityConservation: identityConservationOf({ origin: record.origin }) });
  const refused = await housed.handle(new Request(record.origin + "/@red-cup-engineering/npm-registry-serving-service/0.2.5-dev.0"));
  assert.equal(refused.status, 409);
  assert.equal((await housed.handle(new Request(record.origin + "/@red-cup-engineering/computer-language-systems-engineering-services-section/-/computer-language-systems-engineering-services-section-0.1.4-dev.1.tgz"))).status, 409);
  // A declared path may name the policy itself or a record that holds it (the Worker's operating configuration record).
  const f = await conflictFixture(t), policyPath = join(scratch.root, "policy.json"), recordPath = join(scratch.root, "record.json");
  await writeFile(policyPath, JSON.stringify(f.policy)); await writeFile(recordPath, JSON.stringify({ identityConservation: f.policy }));
  assert.deepEqual(identityConservationOf({ origin, identityConservation: policyPath }), f.policy);
  assert.deepEqual(identityConservationOf({ origin, identityConservation: recordPath }), f.policy);
  assert.deepEqual(identityConservationOf({ origin, identityConservation: f.policy }), f.policy);
  // An untyped or foreign record stops the node at start, as it stops the Worker.
  assert.throws(() => nodeOver(scratch, { version: 1, conflicts: [{ name, version }], reservations: [] }), TypeError);
  assert.throws(() => createNpmRegistry({ storage: scratch.storage, origin, privateScopes: ["@registry-fixture"], identityConservation: record.identityConservation }), TypeError);
});

for (const holding of ["canonical-r2", "native"]) {
  test(`node search excludes the ${holding} conflict and uses only a served version's metadata`, async t => {
    const f = await conflictFixture(t), held = holding === "native" ? f.native : await nodeHoldingCanonical(t, f);
    const node = nodeOver(held, f.policy), before = await storeSnapshot(held.storage);
    const searchPath = "/-/v1/search?text=scope:registry-fixture";
    const raw = await (await held.request(searchPath)).json();
    assert.equal(raw.objects[0].package.version, version, "the raw index chose the quarantined latest tag");
    const reply = await node(searchPath), result = await reply.json();
    assert.equal(reply.status, 200);
    assert.equal(result.total, 1);
    assert.equal(result.objects[0].package.version, "0.2.4");
    assert.equal(result.objects[0].package.description, "received stable product");
    assert.deepEqual(result.objects[0].package.keywords, ["received"]);
    assert.equal((await node("/" + name + "/" + result.objects[0].package.version)).status, 200,
      "the version offered by search is actually served");
    assert.equal((await (await node("/-/v1/search?text=keywords:quarantined")).json()).total, 0);
    assert.equal((await (await node("/-/v1/search?text=keywords:received")).json()).total, 1);
    assert.deepEqual((await (await node(searchPath)).json()).objects, result.objects, "the cached entry is the conserved view");
    assert.deepEqual(await storeSnapshot(held.storage), before, "search does not rewrite the stored identities");

    const healthy = product("0.2.6", "3".repeat(40), { description: "new received product", keywords: ["new"] });
    const body = publishBody(healthy, { origin });
    assert.equal((await node("/" + encodeURIComponent(name), { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) })).status, 201);
    const updated = await (await node(searchPath)).json();
    assert.equal(updated.objects[0].package.version, "0.2.6", "a new publication invalidates the cached conserved entry");
    assert.deepEqual(updated.objects[0].package.keywords, ["new"]);
  });

  test(`node search omits a package holding only its ${holding} quarantined identity`, async t => {
    const f = await conflictFixture(t, { withStable: false }), held = holding === "native" ? f.native : await nodeHoldingCanonical(t, f);
    const node = nodeOver(held, f.policy), before = await storeSnapshot(held.storage);
    for (const path of ["/-/v1/search", "/-/v1/search?text=identity&size=1&from=0"]) {
      const reply = await node(path), result = await reply.json();
      assert.equal(reply.status, 200);
      assert.equal(result.total, 0);
      assert.deepEqual(result.objects, []);
    }
    assert.deepEqual(await storeSnapshot(held.storage), before);
  });

  test(`node search refuses drift from the recorded ${holding} identity before returning or caching a result`, async t => {
    const f = await conflictFixture(t), held = holding === "native" ? f.native : await nodeHoldingCanonical(t, f);
    const policy = structuredClone(f.policy);
    policy.conflicts[0].identities.find(identity => identity.authority === holding).manifestSha256 = "f".repeat(64);
    const node = nodeOver(held, policy), before = await storeSnapshot(held.storage);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(node("/-/v1/search"), /stored conflicting identity drifted/);
    }
    assert.deepEqual(await storeSnapshot(held.storage), before);
  });
}
