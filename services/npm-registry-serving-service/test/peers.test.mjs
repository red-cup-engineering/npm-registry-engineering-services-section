import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registryFixture, authorization } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { MemoryR2 } from "./support/r2.mjs";
import { bucketPeer, registryPeer, receivePeers } from "../src/peers.mjs";
import { createPackageStore } from "../src/store.mjs";

const name = "@registry-fixture/replicated";
const origin = "http://registry.invalid";
const integrityOf = bytes => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const bytesOf = async reply => Buffer.from(await reply.arrayBuffer());

/** A node that has published `versions` itself. */
async function node(t, versions = [], options = {}) {
  const fixture = await registryFixture(t, options), archives = new Map();
  for (const version of versions) {
    const bytes = packagedVersion(name, version);
    archives.set(version, bytes);
    assert.equal((await fixture.publish(bytes)).status, 201);
  }
  return { ...fixture, archives };
}
/** The same node's packument and archives laid out as a bucket holds them (the R2 profile's `<name>/index.json`, `<name>/-/<file>`). */
async function bucketOf(source) {
  const bucket = new MemoryR2();
  bucket.seed(name + "/index.json", JSON.stringify(await (await source.request("/" + encodeURIComponent(name))).json()));
  for (const [version, bytes] of source.archives) bucket.seed(name + "/-/replicated-" + version + ".tgz", bytes);
  return bucket;
}
const countingPeer = peer => {
  const calls = [];
  return { calls, name: peer.name,
    packument: async n => { calls.push(["packument", n]); return peer.packument(n); },
    artifact: async (n, file, dist) => { calls.push(["artifact", file]); return peer.artifact(n, file, dist); } };
};

test("a node reads a house package from a bucket peer on first use and its tarball bytes on first request, then from its own store", async t => {
  const source = await node(t, ["1.0.0", "1.1.0"]), bucket = await bucketOf(source);
  const peer = countingPeer(bucketPeer({ name: "bucket", bucket }));
  const mine = await node(t, [], { peers: [peer] });
  const packument = await (await mine.request("/" + encodeURIComponent(name))).json();
  assert.deepEqual(Object.keys(packument.versions).sort(), ["1.0.0", "1.1.0"]);
  assert.equal(packument.versions["1.0.0"].dist.tarball, origin + "/" + name + "/-/replicated-1.0.0.tgz", "tarball URLs name this node");
  assert.deepEqual(peer.calls, [["packument", name]], "versions are received as facts; their bytes wait until asked for");
  const archive = await mine.request("/" + name + "/-/replicated-1.0.0.tgz");
  assert.equal(archive.status, 200);
  assert.deepEqual(await bytesOf(archive), source.archives.get("1.0.0"));
  assert.equal(packument.versions["1.0.0"].dist.integrity, integrityOf(source.archives.get("1.0.0")));
  assert.deepEqual(peer.calls.at(-1), ["artifact", "replicated-1.0.0.tgz"]);
  const before = peer.calls.length;
  await mine.request("/" + encodeURIComponent(name)); await mine.request("/" + name + "/-/replicated-1.0.0.tgz");
  assert.equal(peer.calls.length, before, "a held package and a held tarball are not asked of the peers again");
});

test("a version published to a peer after a node first held the package reaches it once the refresh interval passes", async t => {
  const source = await node(t, ["1.0.0"]), bucket = await bucketOf(source);
  const peer = countingPeer(bucketPeer({ name: "bucket", bucket }));
  let clock = Date.parse("2026-10-31T00:00:00Z");
  const mine = await node(t, [], { peers: [peer], peerRefreshMs: 60_000, now: () => new Date(clock) });
  const versions = async () => Object.keys((await (await mine.request("/" + encodeURIComponent(name))).json()).versions).sort();
  assert.deepEqual(await versions(), ["1.0.0"]);
  const later = packagedVersion(name, "1.1.0");
  assert.equal((await source.publish(later)).status, 201); source.archives.set("1.1.0", later);
  const republished = await bucketOf(source);
  bucket.seed(name + "/index.json", await republished.get(name + "/index.json").then(o => o.text()));
  bucket.seed(name + "/-/replicated-1.1.0.tgz", later);
  clock += 59_000;
  assert.deepEqual(await versions(), ["1.0.0"], "within the refresh interval the held package is served from the store");
  assert.equal(peer.calls.filter(([kind]) => kind === "packument").length, 1);
  clock += 2_000;
  assert.deepEqual(await versions(), ["1.0.0", "1.1.0"], "after it, the version the peer gained is received");
  const archive = await mine.request("/" + name + "/-/replicated-1.1.0.tgz");
  assert.equal(archive.status, 200);
  assert.deepEqual(await bytesOf(archive), later);
});

test("versions a lockfile names are received with their bytes ahead of use", async t => {
  const source = await node(t, ["1.0.0", "1.1.0"]), bucket = await bucketOf(source);
  const peer = countingPeer(bucketPeer({ name: "bucket", bucket }));
  const mine = await node(t, []);
  const outcome = await receivePeers(createPackageStore({ storage: mine.storage }), name, [peer], { origin, eager: version => version === "1.1.0" });
  assert.deepEqual(outcome.received.sort(), ["1.0.0", "1.1.0"]);
  assert.deepEqual(peer.calls.filter(call => call[0] === "artifact"), [["artifact", "replicated-1.1.0.tgz"]]);
    assert.deepEqual(await bytesOf(await mine.request("/" + name + "/-/replicated-1.1.0.tgz")), source.archives.get("1.1.0"));
});

test("a tarball whose bytes are not the advertised integrity is not served", async t => {
  const source = await node(t, ["1.0.0", "1.1.0"]), bucket = await bucketOf(source);
  bucket.seed(name + "/-/replicated-1.1.0.tgz", packagedVersion(name, "1.1.0", { files: { "extra.mjs": "tampered" } }));
  const mine = await node(t, [], { peers: [bucketPeer({ name: "bucket", bucket })] });
  assert.equal((await mine.request("/" + name + "/-/replicated-1.1.0.tgz")).status, 404);
  assert.deepEqual(await bytesOf(await mine.request("/" + name + "/-/replicated-1.0.0.tgz")), source.archives.get("1.0.0"));
  const eager = await receivePeers(createPackageStore({ storage: (await node(t, [])).storage }), name, [bucketPeer({ name: "bucket", bucket })], { origin, eager: () => true });
  assert.deepEqual(eager.mismatched, ["1.1.0"]); assert.deepEqual(eager.received, ["1.0.0"]);
});

test("a node's own publication builds on the history its peers hold, and writes nothing to them", async t => {
  const source = await node(t, ["1.0.0"]), bucket = await bucketOf(source);
  const mine = await node(t, [], { peers: [bucketPeer({ name: "bucket", bucket })] });
  const next = packagedVersion(name, "1.2.0");
  assert.equal((await mine.publish(next)).status, 201);
  const packument = await (await mine.request("/" + encodeURIComponent(name))).json();
  assert.deepEqual(Object.keys(packument.versions).sort(), ["1.0.0", "1.2.0"]);
  assert.equal(packument["dist-tags"].latest, "1.2.0");
  assert.deepEqual(bucket.calls.filter(call => call.method !== "get"), [], "publishing on this node never writes to a peer");
  const republish = await mine.publish(packagedVersion(name, "1.0.0", { files: { "other.mjs": "x" } }));
  assert.ok(republish.status >= 400 && republish.status < 500, "a version a peer already holds is not published again with other bytes");
});

test("two nodes replicate by content address through the npm protocol, with no node canonical", async t => {
  const a = await node(t, ["1.0.0"]);
  const asPeer = registryPeer({ name: "node-a", url: origin, fetchImpl: (address, init) => a.request(new URL(address).pathname, init) });
  const b = await node(t, [], { peers: [asPeer] });
  const fromA = await (await b.request("/" + encodeURIComponent(name))).json();
  assert.equal(fromA.versions["1.0.0"].dist.integrity, integrityOf(a.archives.get("1.0.0")));
  assert.deepEqual(await bytesOf(await b.request("/" + name + "/-/replicated-1.0.0.tgz")), a.archives.get("1.0.0"));
  // B publishes on its own; A learns it from B the same way. Neither is asked before it publishes.
  assert.equal((await b.publish(packagedVersion(name, "2.0.0"))).status, 201);
  const bAsPeer = registryPeer({ name: "node-b", url: origin, fetchImpl: (address, init) => b.request(new URL(address).pathname, init) });
  const outcome = await receivePeers(createPackageStore({ storage: a.storage }), name, [bAsPeer], { origin });
  assert.deepEqual(outcome.received, ["2.0.0"]);
  assert.deepEqual(Object.keys((await (await a.request("/" + encodeURIComponent(name))).json()).versions).sort(), ["1.0.0", "2.0.0"]);
});

test("a peer's other bytes for a held version are reported as a divergence and never replace it", async t => {
  const mine = await node(t, ["1.0.0"]);
  const other = await node(t, []);
  const rival = packagedVersion(name, "1.0.0", { files: { "rival.mjs": "different" } });
  assert.equal((await other.publish(rival)).status, 201);
  const peer = registryPeer({ name: "rival", url: origin, fetchImpl: (address, init) => other.request(new URL(address).pathname, init) });
  const outcome = await receivePeers(createPackageStore({ storage: mine.storage }), name, [peer], { origin });
  assert.equal(outcome.diverged.length, 1); assert.equal(outcome.diverged[0].version, "1.0.0");
  assert.deepEqual(outcome.received, []);
  assert.deepEqual(await bytesOf(await mine.request("/" + name + "/-/replicated-1.0.0.tgz")), mine.archives.get("1.0.0"));
});

test("public names and unknown house names never reach a peer for bytes they do not hold", async t => {
  const peer = countingPeer({ name: "empty", packument: async () => undefined, artifact: async () => undefined });
  const mine = await node(t, [], { peers: [peer], fetch: async () => new Response("{}", { status: 404 }) });
  assert.equal((await mine.request("/" + encodeURIComponent("@registry-fixture/unknown"))).status, 404);
  await mine.request("/left-pad");
  assert.deepEqual(peer.calls, [["packument", "@registry-fixture/unknown"]]);
  await mine.request("/" + encodeURIComponent("@registry-fixture/unknown"));
  assert.equal(peer.calls.length, 1, "a name no peer holds is not asked for again at once");
});

test("a node that names its canonical publication receiver refuses house publications and tag changes, and keeps serving what its peers hold", async t => {
  const source = await node(t, ["1.0.0"]), bucket = await bucketOf(source);
  const mine = await node(t, [], { peers: [bucketPeer({ name: "bucket", bucket })], canonicalPublication: "https://registry.example" });
  const refused = await mine.publish(packagedVersion(name, "2.0.0"));
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /published at https:\/\/registry\.example/u);
  const tag = await mine.request("/-/package/" + encodeURIComponent(name) + "/dist-tags/next", { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify("1.0.0") });
  assert.equal(tag.status, 403);
  const packument = await (await mine.request("/" + encodeURIComponent(name))).json();
  assert.deepEqual(Object.keys(packument.versions), ["1.0.0"]);
  assert.deepEqual(packument["dist-tags"], { latest: "1.0.0" });
  await assert.rejects(node(t, [], { canonicalPublication: "https://registry.example/path" }), /scheme and host/u);
});
