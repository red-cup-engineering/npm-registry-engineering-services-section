import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createR2Registry } from "../src/r2-registry.mjs";
import { registryFixture, authorization, publishBody } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { MemoryR2 } from "./support/r2.mjs";

const origin = "https://registry.invalid";
const name = "@registry-fixture/r2-concurrency-example";
const custodyKey = version => "-/publication-inputs/" + name + "/" + version + ".json";
const archiveKey = (version, file) => name + "/-/" + file;
const indexKey = name + "/index.json";
const configuration = extra => ({
  origin, privateScopes: ["@registry-fixture", "@red-cup-engineering"], privateNames: [],
  nativePublisherPolicy: "native-authenticated-house-publishers-v1", ...extra,
});

function publication(version = "1.0.0", extra = {}) {
  const bytes = packagedVersion(name, version, { manifest: {
    gitHead: "1".repeat(40), scripts: { test: "node --test" }, ...extra,
  } });
  return { bytes, body: publishBody(bytes, { origin }) };
}

async function fixture(t, { bucket = new MemoryR2(), config = {}, nativeOptions = {}, publishToken = "fixture-r2-authority" } = {}) {
  const native = await registryFixture(t, { origin, ...nativeOptions });
  const receiver = createR2Registry({
    bucket,
    configuration: configuration(config),
    publishToken,
    nativeFetch: request => native.request(new URL(request.url).pathname + new URL(request.url).search, {
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: request.body, duplex: "half" } : {}),
    }),
  });
  const request = (path, init) => receiver.fetch(new Request(origin + path, init));
  const put = (body, auth = authorization) => request("/" + encodeURIComponent(body.name), {
    method: "PUT", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { receiver, request, put, bucket, native };
}

test("Existing OTHER pending claim readback is not-owned; observedInputSha256 stays other actual claim digest, requested hash is current body", async t => {
  const f = await fixture(t);
  const p1 = publication();
  const p2 = publication();

  f.bucket.seed(custodyKey("1.0.0"), JSON.stringify(p1.body), {
    customMetadata: { name, version: "1.0.0", publisher: "other-publisher", inputSha256: createHash("sha256").update(JSON.stringify(p1.body)).digest("hex") },
  });

  const reply = await f.put(p2.body);
  assert.equal(reply.status, 409);
  const json = await reply.json();
  assert.equal(json.custody.state, "not-owned");
  assert.equal(json.custody.requestedInputSha256, createHash("sha256").update(JSON.stringify(p2.body)).digest("hex"));
  assert.equal(json.custody.observedInputSha256, createHash("sha256").update(JSON.stringify(p1.body)).digest("hex"));
});

test("same version competing inputs have one actual conditional owner and never claim the loser's bytes", async t => {
  const f = await fixture(t);
  const inputs = [publication("1.0.0", { description: "first" }), publication("1.0.0", { description: "second" })];
  let arrivals = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  f.bucket.beforePut = async key => {
    if (key !== custodyKey("1.0.0")) return;
    if (++arrivals === 2) release();
    await both;
  };
  const replies = await Promise.all(inputs.map(p => f.put(p.body)));
  assert.deepEqual(replies.map(r => r.status).sort(), [201, 409]);
  const winner = replies.findIndex(r => r.status === 201), loser = 1 - winner;
  const refusal = await replies[loser].json();
  assert.equal(refusal.custody.state, "not-owned");
  assert.equal(refusal.custody.inputSha256, undefined);
  assert.equal(refusal.custody.requestedInputSha256, createHash("sha256").update(JSON.stringify(inputs[loser].body)).digest("hex"));
  assert.deepEqual(f.bucket.objects.get(archiveKey("1.0.0", "r2-concurrency-example-1.0.0.tgz")).bytes, inputs[winner].bytes);
  const actual = JSON.parse(f.bucket.objects.get(indexKey).bytes);
  assert.deepEqual(actual.versions["1.0.0"], { ...inputs[winner].body.versions["1.0.0"], _npmUser: { name: "fixture" } });
  assert.equal(f.bucket.calls.filter(c => c.method === "put" && c.key === indexKey).length, 1);
  assert.equal(f.bucket.calls.filter(c => c.method === "put" && c.key.includes("/-/")).length, 1);
});

test("concurrent different versions conserve the winning metadata and exact losing input/archive without replay", async t => {
  const f = await fixture(t), inputs = [publication("1.0.0"), publication("1.1.0")];
  let arrivals = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  f.bucket.beforePut = async key => { if (key === indexKey) { if (++arrivals === 2) release(); await both; } };
  const replies = await Promise.all(inputs.map(p => f.put(p.body)));
  assert.deepEqual(replies.map(r => r.status).sort(), [201, 409]);
  const winner = replies.findIndex(r => r.status === 201), loser = 1 - winner;
  const winningVersion = Object.keys(inputs[winner].body.versions)[0], losingVersion = Object.keys(inputs[loser].body.versions)[0];
  const doc = JSON.parse(f.bucket.objects.get(indexKey).bytes);
  assert.deepEqual(Object.keys(doc.versions), [winningVersion]);
  assert.deepEqual(f.bucket.objects.get(custodyKey(losingVersion)).bytes, Buffer.from(JSON.stringify(inputs[loser].body)));
  assert.deepEqual(f.bucket.objects.get(archiveKey(losingVersion, "r2-concurrency-example-" + losingVersion + ".tgz")).bytes, inputs[loser].bytes);
  assert.equal(f.bucket.objects.has(custodyKey(winningVersion)), false);
  assert.equal(f.bucket.calls.filter(c => c.method === "put" && c.key === indexKey).length, 2);
});

test("throw before or after input claim has an unreceived claim, never fabricated retained ownership", async t => {
  for (const effect of ["beforePut", "afterPut"]) {
    const f = await fixture(t), p = publication(), encoded = Buffer.from(JSON.stringify(p.body));
    f.bucket[effect] = async key => { if (key === custodyKey("1.0.0")) throw Error("unreceived conditional input effect"); };
    const reply = await f.put(p.body);
    assert.equal(reply.status, 502); assert.equal(reply.headers.get("retry-after"), null);
    const refusal = await reply.json();
    assert.equal(refusal.effectsUnknown, true);
    assert.equal(refusal.custody.state, "claim-unreceived");
    assert.equal(refusal.custody.inputSha256, undefined);
    assert.equal(refusal.custody.requestedInputSha256, createHash("sha256").update(encoded).digest("hex"));
    assert.deepEqual(f.bucket.calls.filter(c => c.method === "put").map(c => c.key), [custodyKey("1.0.0")]);
    if (effect === "afterPut") assert.deepEqual(f.bucket.objects.get(custodyKey("1.0.0")).bytes, encoded);
    else assert.equal(f.bucket.objects.has(custodyKey("1.0.0")), false);
    assert.equal(f.bucket.objects.has(indexKey), false);
  }
});

test("a different held input is reported with its actual observed digest and never overwritten", async t => {
  const f = await fixture(t), held = publication("1.0.0", { description: "owned original" }), current = publication();
  const heldBytes = Buffer.from(JSON.stringify(held.body)), observed = createHash("sha256").update(heldBytes).digest("hex");
  f.bucket.seed(custodyKey("1.0.0"), heldBytes, { customMetadata: { publisher: "other", inputSha256: observed } });
  const reply = await f.put(current.body); assert.equal(reply.status, 409);
  const refusal = await reply.json();
  assert.equal(refusal.custody.state, "not-owned");
  assert.equal(refusal.custody.inputSha256, undefined);
  assert.equal(refusal.custody.observedInputSha256, observed);
  assert.notEqual(refusal.custody.requestedInputSha256, observed);
  assert.deepEqual(f.bucket.objects.get(custodyKey("1.0.0")).bytes, heldBytes);
  assert.equal(f.bucket.calls.filter(c => c.method === "put").length, 0);
});
