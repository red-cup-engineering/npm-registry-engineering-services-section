import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createR2Registry } from "../src/r2-registry.mjs";
import { createR2S3Bucket } from "../src/r2-s3-bucket.mjs";
import { registryFixture, authorization, publishBody } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";

const origin = "https://registry.invalid";
const name = "@registry-fixture/r2-example";
const accountId = "0".repeat(32), bucketName = "npm-registry-fixture";

/** R2's S3 face as the adapter meets it: signed requests, lower-cased metadata names, conditional writes. */
function fakeS3() {
  const objects = new Map(), requests = [];
  const fetchImpl = async (url, init) => {
    const { pathname, host } = new URL(url), method = init.method, headers = new Headers(init.headers);
    assert.equal(host, accountId + ".r2.cloudflarestorage.com");
    assert.match(headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=fixture-key\//u);
    const [, bucket, ...rest] = pathname.split("/"); assert.equal(bucket, bucketName);
    const key = rest.map(decodeURIComponent).join("/"); requests.push({ method, key });
    const old = objects.get(key);
    const reply = (status, object, body) => new Response(body ?? null, { status, headers: object ? {
      etag: '"' + object.etag + '"', "content-length": String(object.bytes.length), "content-type": object.contentType ?? "application/octet-stream",
      ...Object.fromEntries(Object.entries(object.meta).map(([k, v]) => ["x-amz-meta-" + k, v])) } : {} });
    if (method === "GET") return old ? reply(200, old, old.bytes) : new Response("NoSuchKey", { status: 404 });
    if (method === "HEAD") { assert.equal(headers.get("accept-encoding"), "identity", "HEAD names identity encoding so R2 reports the stored size"); return old ? reply(200, old) : new Response(null, { status: 404 }); }
    if (method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    assert.equal(method, "PUT");
    const bytes = Buffer.from(init.body);
    assert.equal(headers.get("x-amz-content-sha256"), createHash("sha256").update(bytes).digest("hex"));
    if (headers.get("if-none-match") === "*" && old) return new Response("PreconditionFailed", { status: 412 });
    const match = headers.get("if-match");
    if (match !== null && (!old || match !== '"' + old.etag + '"')) return new Response("PreconditionFailed", { status: 412 });
    const meta = {};
    for (const [k, v] of headers) if (k.startsWith("x-amz-meta-")) meta[k.slice(11).toLowerCase()] = v;
    const object = { bytes, etag: createHash("md5").update(bytes).digest("hex"), meta, contentType: headers.get("content-type") };
    objects.set(key, object);
    return new Response(null, { status: 200, headers: { etag: '"' + object.etag + '"' } });
  };
  return { objects, requests, bucket: createR2S3Bucket({ accountId, bucket: bucketName, accessKeyId: "fixture-key", secretAccessKey: "fixture-secret", fetchImpl }) };
}

test("the S3 bucket keeps R2's conditional writes and the registry's metadata names", async () => {
  const { bucket, objects } = fakeS3();
  const first = await bucket.put("k", "one", { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { inputSha256: "a", publisher: "p" }, httpMetadata: { contentType: "application/json" } });
  assert.equal(first.etag, createHash("md5").update("one").digest("hex"));
  assert.deepEqual(objects.get("k").meta, { inputsha256: "a", publisher: "p" }, "S3 lower-cases metadata names");
  assert.equal(await bucket.put("k", "two", { onlyIf: { etagDoesNotMatch: "*" } }), null, "create-once refuses an existing object");
  assert.equal(await bucket.put("k", "two", { onlyIf: { etagMatches: "0".repeat(32) } }), null, "a stale etag refuses");
  assert.ok(await bucket.put("k", "two", { onlyIf: { etagMatches: first.etag } }), "the current etag replaces");
  const read = await bucket.get("k");
  assert.equal(await read.text(), "two"); assert.equal(read.size, 3);
  assert.deepEqual((await bucket.head("k")).etag, createHash("md5").update("two").digest("hex"));
  assert.equal((await bucket.head("k")).size, 3);
  await bucket.put("m", "x", { customMetadata: { inputSha256: "b", receivedAt: "t" } });
  assert.deepEqual((await bucket.get("m")).customMetadata, { inputSha256: "b", receivedAt: "t" }, "names read back as written");
  await bucket.delete("k"); assert.equal(await bucket.get("k"), null); assert.equal(await bucket.head("k"), null);
  await assert.rejects(bucket.put("k", "x", { onlyIf: { etagDoesNotMatch: "abc" } }), /only as \*/u);
});

test("a publication through the S3 bucket is received, served, idempotent and immutable", async t => {
  const s3 = fakeS3(), native = await registryFixture(t, { origin });
  const receiver = createR2Registry({ bucket: s3.bucket, publishToken: "fixture-r2-authority",
    configuration: { origin, privateScopes: ["@registry-fixture"], privateNames: [], nativePublisherPolicy: "native-authenticated-house-publishers-v1" },
    nativeFetch: request => native.request(new URL(request.url).pathname, { method: request.method, headers: request.headers }) });
  const put = body => receiver.fetch(new Request(origin + "/" + encodeURIComponent(body.name), {
    method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const bytes = packagedVersion(name, "1.0.0", { manifest: { gitHead: "1".repeat(40) } }), body = publishBody(bytes, { origin });
  const received = await put(body); assert.equal(received.status, 201, await received.clone().text());
  assert.equal((await received.json()).custody.state, "retired");
  assert.deepEqual(s3.objects.get(name + "/-/r2-example-1.0.0.tgz").bytes, bytes);
  assert.equal([...s3.objects.keys()].some(key => key.startsWith("-/publication-inputs/")), false, "the input is retired");
  const served = await receiver.fetch(new Request(origin + "/" + name + "/1.0.0"));
  assert.equal(served.status, 200); assert.equal((await served.json()).version, "1.0.0");
  const writes = () => s3.requests.filter(r => r.method === "PUT").length, before = writes();
  assert.ok([200, 201].includes((await put(body)).status), "an exact duplicate is received"); assert.equal(writes(), before, "and writes nothing");
  const other = publishBody(packagedVersion(name, "1.0.0", { manifest: { gitHead: "2".repeat(40) } }), { origin });
  assert.equal((await put(other)).status, 409, "a published version never changes");
});
