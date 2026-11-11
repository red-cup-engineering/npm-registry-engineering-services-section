import test from "node:test";
import assert from "node:assert/strict";
import { createR2Registry, rewriteOrigin } from "../src/r2-registry.mjs";
import { registryFixture, authorization, publishBody } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { MemoryR2 } from "./support/r2.mjs";

test("Workers Request constructor supports native authenticated reads and publication without error redirect mode", async t => {
  const StandardRequest = globalThis.Request;
  class WorkersRequest extends StandardRequest {
    constructor(input, init) {
      if (init?.redirect === "error") throw new TypeError("Workers does not implement redirect:error");
      super(input, init);
    }
  }
  globalThis.Request = WorkersRequest;
  t.after(() => { globalThis.Request = StandardRequest; });
  assert.throws(() => new Request("https://registry.invalid/-/whoami", { redirect: "error" }), /does not implement/);
  const origin = "https://registry.invalid", native = await registryFixture(t, { origin }), bucket = new MemoryR2();
  const receiver = createR2Registry({ bucket, configuration: {
    origin, privateScopes: ["@registry-fixture"], privateNames: [], nativePublisherPolicy: "native-authenticated-house-publishers-v1",
  }, nativeFetch: request => native.request(new URL(request.url).pathname, { method: request.method, headers: request.headers }) });
  const who = await receiver.fetch(new Request(origin + "/-/whoami", { headers: { authorization } }));
  assert.equal(who.status, 200, await who.clone().text());
  assert.equal((await who.json()).username, "fixture");
  const name = "@registry-fixture/platform-receiving", body = publishBody(packagedVersion(name, "1.0.0"), { origin });
  const reply = await receiver.fetch(new Request(origin + "/" + encodeURIComponent(name), {
    method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal(reply.status, 201, await reply.clone().text());
  assert.deepEqual((await (await receiver.fetch(new Request(origin + "/" + name))).json()).versions["1.0.0"], { ...body.versions["1.0.0"], _npmUser: { name: "fixture" } });
});

const publicOrigin = "https://registry.invalid", uplink = "https://registry.npmjs.org";
const publicConfiguration = extra => ({ origin: publicOrigin, privateScopes: ["@registry-fixture"], privateNames: [], nativePublisherPolicy: "native-authenticated-house-publishers-v1", ...extra });
const streamOf = (text, size) => new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode(text);
  for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
  controller.close();
} });
function publicFixture(answer, extra = {}) {
  const uplinkCalls = [], nativeCalls = [], bucket = new MemoryR2();
  const receiver = createR2Registry({ bucket, configuration: publicConfiguration(extra), publishToken: "fixture-r2-authority",
    nativeFetch: request => { nativeCalls.push(request.url); throw new Error("a public read must not reach the native origin"); },
    uplinkFetch: async request => { uplinkCalls.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), redirect: request.redirect }); return answer(request); } });
  return { receiver, uplinkCalls, nativeCalls, bucket, get: (path, init) => receiver.fetch(new Request(publicOrigin + path, init)) };
}
const packument = name => JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {
  name, version: "1.0.0", dist: { tarball: uplink + "/" + name + "/-/" + name.split("/").pop() + "-1.0.0.tgz", integrity: "sha512-x", shasum: "y" } } } });

test("a non-house packument is read from the public registry with its tarball URLs on this registry, at any chunk size", async () => {
  for (const name of ["typescript", "@babel/runtime"]) {
    const text = packument(name);
    for (const size of [1, 2, 7, 25, 26, 27, 1024]) {
      const f = publicFixture(() => new Response(streamOf(text, size), { status: 200, headers: { "content-type": "application/json", etag: '"u1"', "cache-control": "public, max-age=300" } }));
      const reply = await f.get("/" + encodeURIComponent(name), { headers: { authorization: "Bearer house-secret", cookie: "s=1", accept: "application/vnd.npm.install-v1+json" } });
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get("etag"), '"u1"');
      assert.equal(reply.headers.get("content-length"), null, "a rewritten document has no stale length");
      assert.equal(await reply.text(), text.replaceAll(uplink + "/", publicOrigin + "/"), "chunk size " + size);
      assert.deepEqual(f.nativeCalls, []);
      assert.equal(f.uplinkCalls.length, 1);
      assert.equal(f.uplinkCalls[0].url, uplink + "/" + name);
      assert.equal(f.uplinkCalls[0].headers.authorization, undefined);
      assert.equal(f.uplinkCalls[0].headers.cookie, undefined);
      assert.equal(f.uplinkCalls[0].headers.accept, "application/vnd.npm.install-v1+json");
      assert.equal(f.uplinkCalls[0].redirect, "manual");
      assert.deepEqual(f.bucket.calls.filter(call => call.method === "put"), [], "public bytes are never written to R2");
    }
  }
});

test("a non-house version document, tarball, HEAD, conditional read and dist-tags are the public registry's, with its status", async () => {
  const archive = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 255, 0, 10]);
  const f = publicFixture(request => {
    const path = new URL(request.url).pathname;
    if (path === "/zod/-/zod-3.0.0.tgz") return new Response(request.method === "HEAD" ? null : archive, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(archive.length), etag: '"t"' } });
    if (path === "/zod/3.0.0") return new Response(JSON.stringify({ name: "zod", version: "3.0.0", dist: { tarball: uplink + "/zod/-/zod-3.0.0.tgz" } }), { headers: { "content-type": "application/json" } });
    if (path === "/-/package/@types/node/dist-tags") return new Response('{"latest":"1.0.0"}', { headers: { "content-type": "application/json" } });
    if (path === "/cached") return new Response(null, { status: 304, headers: { etag: '"c"' } });
    if (path === "/missing") return new Response('{"error":"Not found"}', { status: 404, headers: { "content-type": "application/json" } });
    if (path === "/broken") return new Response("upstream failure", { status: 503, headers: { "retry-after": "3", "content-type": "text/plain" } });
    return new Response("unexpected", { status: 418 });
  });
  const tarball = await f.get("/zod/-/zod-3.0.0.tgz");
  assert.equal(tarball.status, 200);
  assert.deepEqual(new Uint8Array(await tarball.arrayBuffer()), archive, "archive bytes pass through unchanged");
  assert.equal(tarball.headers.get("content-length"), String(archive.length));
  const head = await f.get("/zod/-/zod-3.0.0.tgz", { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(archive.length)); assert.equal(await head.text(), "");
  assert.equal(f.uplinkCalls.at(-1).method, "HEAD");
  assert.deepEqual(await (await f.get("/zod/3.0.0")).json(), { name: "zod", version: "3.0.0", dist: { tarball: publicOrigin + "/zod/-/zod-3.0.0.tgz" } });
  assert.deepEqual(await (await f.get("/-/package/@types%2fnode/dist-tags")).json(), { latest: "1.0.0" });
  const cached = await f.get("/cached", { headers: { "if-none-match": '"c"' } });
  assert.equal(cached.status, 304); assert.equal(f.uplinkCalls.at(-1).headers["if-none-match"], '"c"');
  assert.equal((await f.get("/missing")).status, 404);
  const broken = await f.get("/broken");
  assert.equal(broken.status, 503); assert.equal(broken.headers.get("retry-after"), "3"); assert.equal(await broken.text(), "upstream failure");
  for (const path of ["/zod/1/2/3", "/zod/-/..%2fx.tgz", "/zod/-/notes.txt", "/zod/-/a/b.tgz"]) assert.equal((await f.get(path)).status, 404, path);
  assert.deepEqual(f.nativeCalls, []);
});

test("an unanswered public read is bounded and reported as a gateway timeout, never a hang or a native fallback", async () => {
  const f = publicFixture(request => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))), { uplinkTimeoutMs: 20 });
  const started = Date.now(), reply = await f.get("/typescript");
  assert.equal(reply.status, 504); assert.ok(Date.now() - started < 5000);
  assert.equal(reply.headers.get("retry-after"), "5");
  assert.deepEqual(f.nativeCalls, []);
});

test("house names never reach the public registry, and public names cannot be written", async () => {
  const f = publicFixture(() => new Response("{}", { headers: { "content-type": "application/json" } }));
  assert.equal((await f.get("/" + encodeURIComponent("@registry-fixture/absent"))).status, 404);
  assert.equal((await f.get("/@registry-fixture/absent/-/absent-1.0.0.tgz")).status, 404);
  assert.equal((await f.get("/-/package/@registry-fixture%2fabsent/dist-tags")).status, 404);
  assert.deepEqual(f.uplinkCalls, [], "a house name is answered from R2 alone");
  assert.equal((await f.get("/typescript", { method: "PUT", headers: { authorization: "Bearer fixture-r2-authority", "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await f.get("/-/package/typescript/dist-tags/latest", { method: "PUT", body: '"1.0.0"' })).status, 403);
  assert.deepEqual(f.uplinkCalls, []);
});

test("the public uplink is a parameter and must be another https origin", async () => {
  const f = publicFixture(() => new Response("{}", { headers: { "content-type": "application/json" } }), { uplink: "https://npm.mirror.invalid" });
  await f.get("/zod"); assert.equal(f.uplinkCalls[0].url, "https://npm.mirror.invalid/zod");
  for (const uplinkValue of ["http://registry.npmjs.org", "https://registry.npmjs.org/", publicOrigin, "https://x.invalid/path", 7])
    assert.throws(() => createR2Registry({ bucket: new MemoryR2(), configuration: publicConfiguration({ uplink: uplinkValue }) }), /uplink|Invalid URL/u);
});

test("origin rewriting never cuts a match or a character at a chunk boundary", async () => {
  const text = '{"a":"https://registry.npmjs.org/ü/-/ü.tgz","b":"😀https://registry.npmjs.org/😀","c":"https://registry.npmjs.org"}';
  const expected = text.replaceAll("https://registry.npmjs.org/", "https://r.invalid/");
  for (let size = 1; size < 40; size++)
    assert.equal(await new Response(rewriteOrigin(streamOf(text, size), "https://registry.npmjs.org", "https://r.invalid")).text(), expected, "size " + size);
});
