import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createNpmRegistry } from "../src/registry.mjs";
import { registryFixture } from "./support/registry.mjs";

// A public tarball's bytes need not pass through this process: by default the registry answers its own tarball URL
// with a redirect to the uplink's, and only with publicTarballs: "proxy" fetches, checks and relays the bytes.

const bytes = Buffer.from("public tarball bytes");
const shasum = createHash("sha1").update(bytes).digest("hex");
const upstream = "https://uplink.invalid/left-pad/-/left-pad-1.0.0.tgz";
const packument = { name: "left-pad", "dist-tags": { latest: "1.0.0" }, time: { modified: "2020-01-01T00:00:00.000Z" },
  versions: { "1.0.0": { name: "left-pad", version: "1.0.0", dist: { tarball: upstream, shasum } } } };
const uplink = (fetched) => async (url) => { fetched.push(String(url)); return String(url) === upstream ? new Response(bytes) : Response.json(packument); };

test("by default a public tarball is redirected to the uplink's own URL, and its bytes are never fetched here", async (t) => {
  const fetched = [];
  const f = await registryFixture(t, { fetch: uplink(fetched) });
  const response = await f.request("/left-pad/-/left-pad-1.0.0.tgz", { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), upstream);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable", "a version's tarball location never changes");
  assert.ok(!fetched.includes(upstream), "only the packument was read from the uplink");
  const head = await f.request("/left-pad/-/left-pad-1.0.0.tgz", { method: "HEAD", redirect: "manual" });
  assert.equal(head.status, 302);
});

test("a public tarball the uplink does not list is still not found", async (t) => {
  const f = await registryFixture(t, { fetch: uplink([]) });
  assert.equal((await f.request("/left-pad/-/left-pad-9.9.9.tgz", { redirect: "manual" })).status, 404);
});

test("publicTarballs: proxy keeps relaying the checked bytes", async (t) => {
  const fetched = [];
  const f = await registryFixture(t, { fetch: uplink(fetched), publicTarballs: "proxy" });
  const response = await f.request("/left-pad/-/left-pad-1.0.0.tgz");
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.ok(fetched.includes(upstream));
});

test("publicTarballs takes only redirect or proxy", () => {
  assert.throws(() => createNpmRegistry({ storage: "/tmp/x", origin: "https://registry.invalid", publicTarballs: "stream" }), /redirect.*proxy/);
});
