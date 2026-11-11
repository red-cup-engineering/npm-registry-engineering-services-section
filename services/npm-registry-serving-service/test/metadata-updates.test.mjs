import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { authorization, liveRegistry, publishBody, registryFixture } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";

const name = "@registry-fixture/capability";
const tarball = (version) => packagedVersion(name, version);
const stored = async (f) => JSON.parse(await readFile(join(f.storage, name, "package.json"), "utf8"));
const read = async (f) => (await f.request(`/${encodeURIComponent(name)}`)).json();

async function twoVersions(t) {
  const f = await registryFixture(t);
  assert.equal((await f.publish(tarball("1.0.0"))).status, 201);
  assert.equal((await f.publish(tarball("1.1.0"))).status, 201);
  return f;
}

test("a packument PUT that changes only deprecated is a metadata update, the way npm deprecate sends it", async (t) => {
  const f = await twoVersions(t);
  const before = await read(f);
  const body = structuredClone(before);
  body.versions["1.0.0"].deprecated = "use 1.1.0";
  const response = await f.put(name, body);
  assert.equal(response.status, 200);
  const after = await read(f);
  assert.equal(after.versions["1.0.0"].deprecated, "use 1.1.0");
  assert.equal(after.versions["1.1.0"].deprecated, undefined);
  const { deprecated, ...rest } = after.versions["1.0.0"];
  assert.deepEqual(rest, before.versions["1.0.0"], "everything else about the version is as it was, tarball and integrity included");
  assert.deepEqual(after["dist-tags"], before["dist-tags"]);
  const abbreviated = await (await f.request(`/${encodeURIComponent(name)}`, { headers: { accept: "application/vnd.npm.install-v1+json" } })).json();
  assert.equal(abbreviated.versions["1.0.0"].deprecated, "use 1.1.0", "installs see the deprecation");
  // an empty message clears it, as npm deprecate pkg@1.0.0 "" does
  body.versions["1.0.0"].deprecated = "";
  assert.equal((await f.put(name, body)).status, 200);
  assert.equal(Object.hasOwn((await stored(f)).versions["1.0.0"], "deprecated"), false);
  // changing nothing is accepted and writes nothing
  const unchanged = await readFile(join(f.storage, name, "package.json"));
  assert.equal((await f.put(name, body)).status, 200);
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), unchanged);
});

test("a metadata update needs a credential and a package that is published", async (t) => {
  const f = await twoVersions(t);
  const body = await read(f);
  body.versions["1.0.0"].deprecated = "no";
  assert.equal((await f.put(name, body, {})).status, 401);
  assert.equal((await read(f)).versions["1.0.0"].deprecated, undefined);
  assert.equal((await f.put("@registry-fixture/unpublished", { name: "@registry-fixture/unpublished", versions: {} }, { authorization })).status, 400);
});

test("a metadata update never changes what a published version is", async (t) => {
  const f = await twoVersions(t);
  const before = await readFile(join(f.storage, name, "package.json"));
  const cases = [
    ["tarball url", b => { b.versions["1.0.0"].dist.tarball = "http://registry.invalid/elsewhere.tgz"; }, /dist/u],
    ["integrity", b => { b.versions["1.0.0"].dist.integrity = `sha512-${"A".repeat(86)}==`; }, /dist/u],
    ["shasum", b => { b.versions["1.0.0"].dist.shasum = "0".repeat(40); }, /dist/u],
    ["dependencies", b => { b.versions["1.0.0"].dependencies = { "left-pad": "1.0.0" }; }, /dependencies/u],
    ["exports", b => { b.versions["1.0.0"].exports = "./other.mjs"; }, /exports/u],
    ["a field removed", b => { delete b.versions["1.0.0"].repository; }, /repository/u],
    ["a field added", b => { b.versions["1.0.0"].scripts = { postinstall: "x" }; }, /scripts/u],
    ["deprecated alongside a change", b => { b.versions["1.0.0"].deprecated = "x"; b.versions["1.0.0"].description = "new"; }, /description/u],
  ];
  for (const [label, mutate, pattern] of cases) {
    const body = await read(f); mutate(body);
    const response = await f.put(name, body);
    assert.equal(response.status, 409, label);
    assert.match((await response.json()).error, pattern, label);
  }
  const removed = await read(f); delete removed.versions["1.0.0"];
  const removal = await f.put(name, removed);
  assert.equal(removal.status, 409); assert.match((await removal.json()).error, /1\.0\.0 is published; a version is never removed/u);
  const retagged = await read(f); retagged["dist-tags"].latest = "1.0.0";
  assert.equal((await f.put(name, retagged)).status, 409);
  const added = await read(f); added.versions["2.0.0"] = { ...added.versions["1.1.0"], version: "2.0.0" };
  assert.equal((await f.put(name, added)).status, 400, "a new version needs its tarball");
  const malformed = await read(f); malformed.versions["1.0.0"].deprecated = { message: "x" };
  assert.equal((await f.put(name, malformed)).status, 400);
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), before, "every refusal left the package as it was");
});

test("tarball replacement still refuses, with or without attachments", async (t) => {
  const f = await twoVersions(t);
  const before = await readFile(join(f.storage, name, "package.json"));
  const other = packagedVersion(name, "1.0.0", { files: { "MARKER.txt": "replacement" } });
  const response = await f.publish(other);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /1\.0\.0 is already published; a version is never replaced/u);
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), before);
  const dist = await (await f.request(`/${encodeURIComponent(name)}/1.0.0`)).json();
  assert.deepEqual(Buffer.from(await (await f.request(new URL(dist.dist.tarball).pathname)).arrayBuffer()), tarball("1.0.0"));
});

test("dist-tags are set, read and removed at their own endpoints", async (t) => {
  const f = await twoVersions(t);
  const tags = `/-/package/${encodeURIComponent(name)}/dist-tags`;
  const send = (path, method, body, headers = { authorization }) => f.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await send(`${tags}/beta`, "PUT", "1.0.0")).status, 201);
  assert.deepEqual(await (await f.request(tags)).json(), { latest: "1.1.0", beta: "1.0.0" });
  assert.equal((await send(`${tags}/beta`, "PUT", "1.1.0")).status, 201, "a tag moves");
  assert.equal(await (await f.request(`${tags}/beta`)).json(), "1.1.0");
  assert.equal((await send(`${tags}/beta`, "DELETE", undefined, {})).status, 401);
  assert.equal((await send(`${tags}/beta`, "DELETE")).status, 200);
  assert.deepEqual(await (await f.request(tags)).json(), { latest: "1.1.0" });
  assert.equal((await send(`${tags}/beta`, "DELETE")).status, 404, "removing what is not there");
  assert.equal((await send(`${tags}/latest`, "DELETE")).status, 400, "latest moves; it is not removed");
  assert.equal((await send(`${tags}/ghost`, "PUT", "9.9.9")).status, 404, "a tag names a published version");
  assert.equal((await send(`${tags}/1.0.0`, "PUT", "1.1.0")).status, 400, "a tag that a range could name");
  assert.equal((await send(`${tags}/^1`, "PUT", "1.1.0")).status, 400);
  assert.equal((await send(`${tags}/next`, "PUT", { version: "1.0.0" })).status, 400);
  assert.equal((await send(`${tags}/next`, "PUT", undefined)).status, 400);
  assert.equal((await send(`${tags}/next`, "PUT", "1.0.0", {})).status, 401);
  assert.deepEqual((await stored(f))["dist-tags"], { latest: "1.1.0" });
  assert.equal(JSON.stringify((await stored(f)).versions["1.0.0"]).includes("beta"), false);
});

test("real npm: deprecate, undeprecate and dist-tag work against the registry; unpublish and republish do not", { timeout: 120_000 }, async (t) => {
  const f = await liveRegistry(t);
  await f.publishPackage(name, "1.0.0");
  await f.publishPackage(name, "1.1.0");
  await f.publishPackage(name, "2.0.0");

  // npm deprecate: GET the packument, PUT it back whole
  await f.npm(["deprecate", `${name}@1.0.0`, "superseded by 1.1.0"]);
  let packument = await f.packument(name);
  assert.equal(packument.versions["1.0.0"].deprecated, "superseded by 1.1.0");
  assert.equal(packument.versions["1.1.0"].deprecated, undefined);
  assert.match((await f.npm(["view", `${name}@1.0.0`, "deprecated"])).stdout, /superseded by 1\.1\.0/u);
  // a range deprecates every version it covers
  await f.npm(["deprecate", `${name}@<2.0.0`, "old line"]);
  packument = await f.packument(name);
  assert.deepEqual([packument.versions["1.0.0"].deprecated, packument.versions["1.1.0"].deprecated, packument.versions["2.0.0"].deprecated], ["old line", "old line", undefined]);
  // an empty message undeprecates
  await f.npm(["deprecate", `${name}@1.1.0`, ""]);
  assert.equal((await f.packument(name)).versions["1.1.0"].deprecated, undefined);
  // the artifact is untouched by all of it
  const integrity = packument.versions["1.0.0"].dist.integrity;
  assert.equal((await f.packument(name)).versions["1.0.0"].dist.integrity, integrity);

  // npm dist-tag add / ls / rm
  await f.npm(["dist-tag", "add", `${name}@1.0.0`, "stable"]);
  assert.match((await f.npm(["dist-tag", "ls", name])).stdout, /stable: 1\.0\.0/u);
  await f.npm(["dist-tag", "add", `${name}@1.1.0`, "stable"]);
  assert.match((await f.npm(["dist-tag", "ls", name])).stdout, /stable: 1\.1\.0/u);
  await f.npm(["dist-tag", "rm", name, "stable"]);
  const listed = (await f.npm(["dist-tag", "ls", name])).stdout;
  assert.doesNotMatch(listed, /stable/u);
  assert.match(listed, /latest: /u);
  await assert.rejects(f.npm(["dist-tag", "rm", name, "latest"]), /latest|400/u);
  await assert.rejects(f.npm(["dist-tag", "rm", name, "never-was"]), /404|never-was/u);

  // a version is never replaced, and npm unpublish is not a way around it
  const original = Buffer.from(await (await fetch(packument.versions["1.0.0"].dist.tarball)).arrayBuffer());
  await assert.rejects(f.publishPackage(name, "1.0.0", { "index.mjs": "export const version = 'replaced';\n" }, {}, ["--tag", "replay"]), /409|already published|never replaced/u);
  await assert.rejects(f.npm(["unpublish", `${name}@1.0.0`, "--force"]), /405|never removed/u);
  await assert.rejects(f.npm(["unpublish", name, "--force"]), /405|never removed/u);
  assert.deepEqual(Buffer.from(await (await fetch(packument.versions["1.0.0"].dist.tarball)).arrayBuffer()), original);
  assert.deepEqual(Object.keys((await f.packument(name)).versions), ["1.0.0", "1.1.0", "2.0.0"]);
});

test("real npm: deprecate without a credential is refused", { timeout: 60_000 }, async (t) => {
  const f = await liveRegistry(t);
  await f.publishPackage(name, "1.0.0");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(f.env.NPM_CONFIG_USERCONFIG, `registry=${f.origin}\n`);
  await assert.rejects(f.npm(["deprecate", `${name}@1.0.0`, "anonymous"]), /401|credential|ENEEDAUTH/u);
  assert.equal((await f.packument(name)).versions["1.0.0"].deprecated, undefined);
});
