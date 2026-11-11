import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";
import { removePublicLeftovers } from "../src/leftovers.mjs";
import { receiveStore } from "../src/reception.mjs";
import { createNpmRegistry } from "../src/registry.mjs";
import { authorization, publishBody, registryFixture } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";

// The registry's data is its facts: a journal per package and tarballs by NI address. These tests read the store
// itself, then the documents served from it.

const name = "@registry-fixture/capability";
const escaped = encodeURIComponent(name);
const journal = async (f) => (await readFile(join(f.storage, name, "facts.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const blobPath = (storage, ni) => { const digest = ni.slice("ni:///sha-256;".length); return join(storage, "-", "blobs", "sha-256", digest.slice(0, 2), digest); };
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

test("a publication is recorded as facts, and its tarball is kept once under its NI address", async (t) => {
  const f = await registryFixture(t);
  const bytes = packagedVersion(name, "1.0.0");
  assert.equal((await f.publish(bytes)).status, 201);
  const rows = await journal(f);
  assert.deepEqual(rows.map(({ e, a }) => [e, a]), [
    ["pkg:npm/%40registry-fixture/capability@1.0.0", "npm.publication"],
    ["pkg:npm/%40registry-fixture/capability", "npm.dist-tag"],
  ]);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["a", "e", "t", "v"], "each fact is an EAVT row and nothing more");
  const { manifest, artifact } = rows[0].v;
  assert.equal(manifest.dist.tarball, undefined, "the tarball URL is the origin's, derived, not a fact");
  assert.equal(manifest.dist.integrity, integrity(bytes));
  assert.deepEqual(manifest._npmUser, { name: "fixture" });
  assert.deepEqual(artifact, { file: "capability-1.0.0.tgz", ni: makeNiUri(bytes), size: bytes.length });
  const blob = await stat(blobPath(f.storage, artifact.ni)), leaf = await stat(join(f.storage, name, "capability-1.0.0.tgz"));
  assert.equal(blob.ino, leaf.ino, "the earlier layout's leaf names the same bytes, not a copy");
  assert.deepEqual(await readFile(blobPath(f.storage, artifact.ni)), bytes);
  const layout = JSON.parse(await readFile(join(f.storage, name, "package.json"), "utf8"));
  const served = await (await f.request(`/${escaped}`)).json();
  assert.equal(layout._rev, served._rev, "the earlier layout is the projection at this journal state");
  assert.deepEqual(layout.versions, served.versions);
  assert.deepEqual(layout._attachments, { "capability-1.0.0.tgz": { shasum: manifest.dist.shasum } });
});

// A package as the earlier (Verdaccio-layout) store wrote it, in the shapes registry.561.group holds: Verdaccio's
// `_id` and `users`, a top-level readme, a deprecation, a dist-tag beside latest, and a `modified` time after the
// last publication (the deprecation moved it).
async function earlierLayout(storage, { versions = ["1.0.0", "1.1.0"], extra = {} } = {}) {
  await mkdir(join(storage, name), { recursive: true });
  const time = { created: "2026-01-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z" };
  const packument = { name, _id: name, users: {}, readme: "# Capability\n", "dist-tags": { latest: versions.at(-1), stable: versions[0] }, versions: {}, time, _attachments: {}, _uplinks: {}, _distfiles: {}, ...extra };
  const tarballs = {};
  versions.forEach((version, index) => {
    const bytes = packagedVersion(name, version, { files: { "MARKER.txt": `earlier ${version}` } });
    tarballs[version] = bytes;
    time[version] = `2026-0${index + 1}-01T00:00:00.000Z`;
    packument.versions[version] = {
      name, version, _id: `${name}@${version}`, type: "module", exports: "./index.mjs", contributors: [], _npmUser: index === 0 ? undefined : { name: "emsenn" },
      repository: { type: "git", url: "https://github.com/registry-fixture/capability.git" },
      ...(index === 0 ? { deprecated: "use a later version" } : {}),
      dist: { shasum: createHash("sha1").update(bytes).digest("hex"), integrity: integrity(bytes), tarball: `https://registry.561.group/${name}/-/capability-${version}.tgz` },
    };
    if (packument.versions[version]._npmUser === undefined) delete packument.versions[version]._npmUser;
  });
  for (const [version, bytes] of Object.entries(tarballs)) await writeFile(join(storage, name, `capability-${version}.tgz`), bytes);
  await writeFile(join(storage, name, "package.json"), JSON.stringify(packument));
  return { packument, tarballs };
}
/** What the earlier registry served for a stored packument: it without its bookkeeping, tarballs on this origin. */
function servedBefore(packument, origin) {
  const { _attachments, _uplinks, _distfiles, _rev, ...shown } = packument;
  const versions = Object.fromEntries(Object.entries(packument.versions).map(([version, manifest]) => [version, { ...manifest, dist: { ...manifest.dist, tarball: `${origin}/${name}/-/capability-${version}.tgz` } }]));
  return { ...shown, versions };
}
const subsetOf = (served, before) => { for (const [key, value] of Object.entries(before)) assert.deepEqual(served[key], value, key); };

test("a package the earlier store wrote is served from its packument read as the facts it records, and reading writes nothing", async (t) => {
  const f = await registryFixture(t);
  const { packument } = await earlierLayout(f.storage);
  const before = await readFile(join(f.storage, name, "package.json"));
  const served = await (await f.request(`/${escaped}`)).json();
  subsetOf(served, servedBefore(packument, f.origin));
  assert.equal(served._id, name);
  assert.match(served._rev, /^\d+-[A-Za-z0-9_-]{32}$/u);
  assert.equal(served.repository.url, "https://github.com/registry-fixture/capability.git", "top-level fields come from latest, as npm's registry presents them");
  assert.deepEqual(served.maintainers, [{ name: "emsenn" }]);
  const install = await (await f.request(`/${escaped}`, { headers: { accept: "application/vnd.npm.install-v1+json" } })).json();
  assert.equal(install.modified, packument.time.modified);
  assert.equal(install.versions["1.0.0"].deprecated, "use a later version");
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), before);
  await assert.rejects(stat(join(f.storage, name, "facts.jsonl")), { code: "ENOENT" });
  const tarball = await f.request(new URL(served.versions["1.1.0"].dist.tarball).pathname);
  assert.equal(integrity(Buffer.from(await tarball.arrayBuffer())), packument.versions["1.1.0"].dist.integrity);
});

test("reception writes the earlier packument down as facts that serve it the same, adopts its tarballs by hard link, and is idempotent", async (t) => {
  const f = await registryFixture(t);
  const { packument, tarballs } = await earlierLayout(f.storage);
  const registry = createNpmRegistry({ storage: f.storage, htpasswd: join(f.root, "htpasswd"), origin: f.origin, privateScopes: ["@registry-fixture"] });
  const before = await (await f.request(`/${escaped}`)).json();
  const first = await receiveStore(registry.store, { origin: f.origin, admits: registry.isPrivate });
  assert.deepEqual([first.received, first.refused, first.incomplete], [1, [], []]);
  const rows = await journal(f);
  assert.deepEqual(rows.map((row) => row.a), ["npm.publication", "npm.publication", "npm.dist-tag", "npm.dist-tag", "npm.deprecation", "npm.readme", "npm.packument-fields", "npm.reception"]);
  assert.deepEqual(rows.find((row) => row.a === "npm.packument-fields").v, { users: {} });
  for (const [version, bytes] of Object.entries(tarballs)) {
    const ni = makeNiUri(bytes);
    assert.equal(rows.find((row) => row.e.endsWith(`@${version}`)).v.artifact.ni, ni);
    assert.equal((await stat(blobPath(f.storage, ni))).ino, (await stat(join(f.storage, name, `capability-${version}.tgz`))).ino);
  }
  const after = await (await f.request(`/${escaped}`)).json();
  const { _rev: revisionBefore, ...restBefore } = before, { _rev: revisionAfter, ...restAfter } = after;
  assert.deepEqual(restAfter, restBefore, "the facts serve exactly what the earlier packument served");
  subsetOf(after, servedBefore(packument, f.origin));
  const second = await receiveStore(registry.store, { origin: f.origin, admits: registry.isPrivate });
  assert.deepEqual([second.received, second.unchanged, second.materialized], [0, 1, 0]);
  assert.equal((await journal(f)).length, rows.length);
});

test("reception leaves a packument its facts would not serve the same exactly as it was, and says why", async (t) => {
  const f = await registryFixture(t);
  await earlierLayout(f.storage, { extra: { time: { created: "2026-01-01T00:00:00.000Z", modified: "2026-03-01T00:00:00.000Z", unpublished: { time: "2026-02-15T00:00:00.000Z" } } } });
  const before = await readFile(join(f.storage, name, "package.json"));
  const registry = createNpmRegistry({ storage: f.storage, htpasswd: join(f.root, "htpasswd"), origin: f.origin, privateScopes: ["@registry-fixture"] });
  const summary = await receiveStore(registry.store, { origin: f.origin, admits: registry.isPrivate });
  assert.equal(summary.refused.length, 1);
  assert.deepEqual(summary.refused[0].disagreements, ["time"]);
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), before);
  await assert.rejects(stat(join(f.storage, name, "facts.jsonl")), { code: "ENOENT" });
  const refused = await f.publish(packagedVersion(name, "2.0.0"));
  assert.equal(refused.status, 500, "a write never builds on a packument it could not receive");
  assert.match((await refused.json()).error, /nothing was changed/u);
  assert.deepEqual(await readFile(join(f.storage, name, "package.json")), before);
});

test("a publication to a package still in the earlier layout receives it first, then records the new version beside it", async (t) => {
  const f = await registryFixture(t);
  const { packument } = await earlierLayout(f.storage);
  assert.equal((await f.publish(packagedVersion(name, "2.0.0"))).status, 201);
  const rows = await journal(f);
  assert.equal(rows.filter((row) => row.a === "npm.publication").length, 3);
  const served = await (await f.request(`/${escaped}`)).json();
  assert.deepEqual(Object.keys(served.versions), ["1.0.0", "1.1.0", "2.0.0"]);
  assert.equal(served["dist-tags"].latest, "2.0.0");
  assert.equal(served["dist-tags"].stable, "1.0.0");
  assert.deepEqual(served.versions["1.0.0"], servedBefore(packument, f.origin).versions["1.0.0"]);
});

test("a version an earlier release published to the layout after a rollback is received, never lost", async (t) => {
  const f = await registryFixture(t);
  assert.equal((await f.publish(packagedVersion(name, "1.0.0"))).status, 201);
  // An earlier release writes the layout as it always did: a new version, its leaf, and latest moved to it.
  const layout = JSON.parse(await readFile(join(f.storage, name, "package.json"), "utf8"));
  const bytes = packagedVersion(name, "1.1.0");
  const { versions } = publishBody(bytes, { origin: f.origin });
  layout.versions["1.1.0"] = { ...versions["1.1.0"], _npmUser: { name: "fixture" } };
  layout.time["1.1.0"] = layout.time.modified = "2030-01-01T00:00:00.000Z";
  layout["dist-tags"].latest = "1.1.0";
  await writeFile(join(f.storage, name, "capability-1.1.0.tgz"), bytes);
  await writeFile(join(f.storage, name, "package.json"), JSON.stringify(layout));
  const registry = createNpmRegistry({ storage: f.storage, htpasswd: join(f.root, "htpasswd"), origin: f.origin, privateScopes: ["@registry-fixture"] });
  const summary = await receiveStore(registry.store, { origin: f.origin, admits: registry.isPrivate });
  assert.equal(summary.received, 1);
  const served = await (await f.request(`/${escaped}`)).json();
  assert.deepEqual(Object.keys(served.versions), ["1.0.0", "1.1.0"]);
  assert.equal(served["dist-tags"].latest, "1.1.0");
  assert.equal(served.time["1.1.0"], "2030-01-01T00:00:00.000Z");
  const tarball = await f.request(new URL(served.versions["1.1.0"].dist.tarball).pathname);
  assert.deepEqual(Buffer.from(await tarball.arrayBuffer()), bytes);
});

test("an append cut short is not read, and is cut back before the next one", async (t) => {
  const f = await registryFixture(t);
  assert.equal((await f.publish(packagedVersion(name, "1.0.0"))).status, 201);
  await appendFile(join(f.storage, name, "facts.jsonl"), '{"e":"pkg:npm/%40registry-fixture/capability","a":"npm.dist-tag","v":{"tag":"cut');
  assert.deepEqual(Object.keys((await (await f.request(`/${escaped}`)).json()).versions), ["1.0.0"]);
  assert.equal((await f.publish(packagedVersion(name, "1.1.0"))).status, 201);
  const text = await readFile(join(f.storage, name, "facts.jsonl"), "utf8");
  assert.ok(!text.includes('"cut'), "the cut-short line is gone");
  assert.equal((await journal(f)).filter((row) => row.a === "npm.publication").length, 2);
});

test("a second publication of a version is a contradiction: kept as evidence, kept out of every document", async (t) => {
  const f = await registryFixture(t);
  const bytes = packagedVersion(name, "1.0.0");
  assert.equal((await f.publish(bytes)).status, 201);
  const [first] = await journal(f);
  await appendFile(join(f.storage, name, "facts.jsonl"), `${JSON.stringify({ ...first, v: { ...first.v, manifest: { ...first.v.manifest, description: "a later claim" } }, t: "2030-01-01T00:00:00.000Z" })}\n`);
  const served = await (await f.request(`/${escaped}/1.0.0`)).json();
  assert.equal(served.description, undefined, "the first publication is the version");
  const registry = createNpmRegistry({ storage: f.storage, htpasswd: join(f.root, "htpasswd"), origin: f.origin, privateScopes: ["@registry-fixture"] });
  const summary = await receiveStore(registry.store, { origin: f.origin, admits: registry.isPrivate });
  assert.deepEqual(summary.incomplete, [{ name, missing: [], mismatched: [], contradictions: 1 }]);
});

test("two registries sharing one store (as two processes would) serialize their writers through the store's lock", async (t) => {
  const f = await registryFixture(t);
  const other = createNpmRegistry({ storage: f.storage, htpasswd: join(f.root, "htpasswd"), origin: f.origin, privateScopes: ["@registry-fixture"] });
  const viaOther = (bytes) => { const body = publishBody(bytes, { origin: f.origin }); return other.handle(new Request(`${f.origin}/${escaped}`, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) })); };
  const versions = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"];
  const statuses = await Promise.all(versions.map((version, index) => (index % 2 === 0 ? f.publish(packagedVersion(name, version)) : viaOther(packagedVersion(name, version)))));
  assert.deepEqual(statuses.map((response) => response.status), [201, 201, 201, 201]);
  assert.deepEqual((await journal(f)).filter((row) => row.a === "npm.publication").map((row) => row.v.manifest.version).sort(), versions);
  const same = packagedVersion(name, "2.0.0");
  const raced = await Promise.all([f.publish(same), viaOther(same)]);
  assert.deepEqual(raced.map((response) => response.status).sort(), [201, 409]);
  await assert.rejects(stat(join(f.storage, name, ".lock")), { code: "ENOENT" }, "no lock outlives its writer");
});

test("a lock left by a writer that has exited is taken over", async (t) => {
  const f = await registryFixture(t);
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  await mkdir(join(f.storage, name), { recursive: true });
  await writeFile(join(f.storage, name, ".lock"), `${exited.stdout} ${new Date().toISOString()}\n`);
  const started = Date.now();
  assert.equal((await f.publish(packagedVersion(name, "1.0.0"))).status, 201);
  assert.ok(Date.now() - started < 5000);
});

test("startup cleanup of public names' leftovers never touches the store's own blobs", async (t) => {
  const f = await registryFixture(t);
  assert.equal((await f.publish(packagedVersion(name, "1.0.0"))).status, 201);
  await mkdir(join(f.storage, "left-pad"), { recursive: true });
  const report = await removePublicLeftovers({ configuration: { privateScopes: ["@registry-fixture"], cachePublicTarballs: false }, storage: f.storage });
  assert.equal(report.removedNames, 1);
  assert.deepEqual((await readdir(f.storage)).sort(), ["-", "@registry-fixture"]);
  assert.equal((await f.request(`/${escaped}/-/capability-1.0.0.tgz`)).status, 200);
});

test("the uplink-prune job never takes the store's own blobs for an unused public name", async (t) => {
  const f = await registryFixture(t);
  assert.equal((await f.publish(packagedVersion(name, "1.0.0"))).status, 201);
  await mkdir(join(f.storage, "left-pad"), { recursive: true });
  await writeFile(join(f.storage, "left-pad", "package.json"), "{}");
  const month = new Date(Date.now() - 30 * 86_400_000);
  for (const path of [join(f.storage, "-"), join(f.storage, "-", "blobs"), join(f.storage, "left-pad", "package.json")]) await utimes(path, month, month);
  const configuration = join(f.root, "registry.json");
  await writeFile(configuration, JSON.stringify({ storage: f.storage, privateScopes: ["@registry-fixture"], cachePublicTarballs: false }));
  const report = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/prune-uplink-cache.mjs", import.meta.url)), "--configuration", configuration], { encoding: "utf8" }));
  assert.deepEqual([report.publicNames, report.removedNames], [1, 1]);
  assert.deepEqual((await readdir(f.storage)).sort(), ["-", "@registry-fixture"]);
  const [publication] = await journal(f);
  assert.ok((await stat(blobPath(f.storage, publication.v.artifact.ni))).isFile());
});

test("reception recovers a scoped tarball the retired publisher left under npm's attachment key, only when its bytes are the advertised ones", async (t) => {
  const f = await registryFixture(t);
  const { tarballs } = await earlierLayout(f.storage);
  // As the retired publisher wrote it: <storage>/@scope/name/@scope/name-<version>.tgz, no leaf.
  const scoped = (version) => join(f.storage, name, `${name}-${version}.tgz`);
  await mkdir(join(f.storage, name, "@registry-fixture"), { recursive: true });
  await writeFile(scoped("1.0.0"), tarballs["1.0.0"]);
  await writeFile(scoped("1.1.0"), Buffer.from("not the advertised bytes"));
  for (const version of ["1.0.0", "1.1.0"]) await (await import("node:fs/promises")).rm(join(f.storage, name, `capability-${version}.tgz`));
  assert.equal((await f.request(`/${escaped}/-/capability-1.0.0.tgz`)).status, 404, "the earlier layout does not serve it");
  const registry = createNpmRegistry({ storage: f.storage, htpasswd: join(f.root, "htpasswd"), origin: f.origin, privateScopes: ["@registry-fixture"] });
  const summary = await receiveStore(registry.store, { origin: f.origin, admits: registry.isPrivate });
  assert.deepEqual(summary.recovered, [{ name, versions: ["1.0.0"] }]);
  assert.deepEqual(summary.incomplete, [{ name, missing: [], mismatched: ["1.1.0"], contradictions: 0 }]);
  const recovered = await f.request(`/${escaped}/-/capability-1.0.0.tgz`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), tarballs["1.0.0"]);
  assert.equal((await stat(join(f.storage, name, "capability-1.0.0.tgz"))).ino, (await stat(scoped("1.0.0"))).ino, "linked at its leaf, not copied");
  assert.equal((await f.request(`/${escaped}/-/capability-1.1.0.tgz`)).status, 404, "bytes that are not the advertised ones are never served as them");
  await assert.rejects(stat(join(f.storage, name, "capability-1.1.0.tgz")), { code: "ENOENT" });
});
