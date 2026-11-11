import test from "node:test";
import assert from "node:assert/strict";
import { createR2Registry } from "../src/r2-registry.mjs";
import { carryHeld } from "../src/carry-held.mjs";
import { createPackageStore } from "../src/store.mjs";
import { registryFixture, authorization, publishBody } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { MemoryR2 } from "./support/r2.mjs";

const origin = "https://registry.invalid";
const name = "@registry-fixture/carried";

/** A node holding the versions `local` (it published them itself) and the canonical R2 receiver holding `published`,
 * authenticating publishers through a native registry as in production. */
async function nodeAndReceiver(t, { local, published = [] }) {
  const node = await registryFixture(t, { origin }), native = await registryFixture(t, { origin });
  const receiver = createR2Registry({ bucket: new MemoryR2(),
    configuration: { origin, privateScopes: ["@registry-fixture"], privateNames: [], nativePublisherPolicy: "native-authenticated-house-publishers-v1" },
    uplinkFetch: async request => { throw new Error("unexpected public read " + request.url); },
    nativeFetch: request => native.request(new URL(request.url).pathname + new URL(request.url).search,
      { method: request.method, headers: request.headers, ...(request.body ? { body: request.body, duplex: "half" } : {}) }) });
  const archives = new Map();
  for (const [version, manifest] of local) {
    const bytes = packagedVersion(name, version, { manifest }); archives.set(version, bytes);
    assert.equal((await node.publish(bytes)).status, 201);
  }
  for (const [version, manifest] of published) {
    const sent = await receiver.fetch(new Request(origin + "/" + encodeURIComponent(name), { method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(publishBody(packagedVersion(name, version, { manifest }), { origin })) }));
    assert.equal(sent.status, 201, await sent.clone().text());
  }
  const canonical = path => receiver.fetch(new Request(origin + path));
  return { node, store: createPackageStore({ storage: node.storage }), receiver, canonical, archives };
}
const carry = f => carryHeld(f.store, name, { canonical: origin, authorization, fetch: request => f.receiver.fetch(request) });

test("versions only a node holds are carried to the canonical receiver as its ordinary publications, with their exact bytes and no tag", async t => {
  const f = await nodeAndReceiver(t, { local: [["1.0.0", {}], ["1.1.0", {}]] });
  const report = await carry(f);
  assert.deepEqual(report.carried.sort(), ["1.0.0", "1.1.0"]);
  assert.deepEqual([report.refused, report.diverged, report.unreadable], [[], [], []]);
  const local = await (await f.node.request("/" + encodeURIComponent(name))).json();
  const packument = await (await f.canonical("/" + encodeURIComponent(name))).json();
  for (const [version, bytes] of f.archives) {
    const archive = await f.canonical("/" + name + "/-/carried-" + version + ".tgz");
    assert.equal(archive.status, 200);
    assert.deepEqual(Buffer.from(await archive.arrayBuffer()), bytes, "the canonical archive is the node's exact archive");
    assert.equal(packument.versions[version].dist.integrity, local.versions[version].dist.integrity);
  }
  assert.deepEqual(packument["dist-tags"] ?? {}, {}, "carrying moves no tag");
  assert.deepEqual((await carry(f)).carried, [], "a carried version is not sent again");
});

test("a version the canonical receiver holds under other bytes is reported as diverged and never sent", async t => {
  const f = await nodeAndReceiver(t, { local: [["1.0.0", { gitHead: "a".repeat(40) }]], published: [["1.0.0", { gitHead: "b".repeat(40) }]] });
  const before = await (await f.canonical("/" + encodeURIComponent(name))).json();
  const report = await carry(f);
  assert.deepEqual(report.carried, []);
  assert.deepEqual(report.diverged.map(d => d.version), ["1.0.0"]);
  const after = await (await f.canonical("/" + encodeURIComponent(name))).json();
  assert.deepEqual(after.versions, before.versions, "the canonical version is unchanged");
});
