import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { liveRegistry, publishBody, registryFixture } from "./support/registry.mjs";
import { readTarball } from "../src/tarball-reader.mjs";
import { packagedVersion, packTarball } from "./support/tarball.mjs";

// The gate as the registry applies it: a refused publish is a 400 naming every problem, and nothing is stored.

const real = (file) => fileURLToPath(new URL(`./fixtures/real-publications/${file}`, import.meta.url));
// The house packages the real publications depend on, as registry.561.group served them on 2026-10-17: each
// version's name, version and exports (the only parts of a manifest the gate reads).
const housePackuments = JSON.parse(await readFile(real("house-packuments.json"), "utf8"));
// `without` is the package being published: the shelf holds its dependencies, not it.
async function stockedFixture(t, without = []) {
  const f = await registryFixture(t);
  for (const [name, packument] of Object.entries(housePackuments)) {
    if (without.includes(name)) continue;
    await mkdir(join(f.storage, name), { recursive: true });
    await writeFile(join(f.storage, name, "package.json"), JSON.stringify(packument));
  }
  return f;
}
const noPackage = async (f, name) => assert.equal((await f.request(`/${encodeURIComponent(name)}`)).status, 404, `${name} was stored`);

test("semiotic-eavt-services-section 0.1.4, as published, is refused for the import that no version of its dependency exports", async (t) => {
  const f = await stockedFixture(t, ["@red-cup-engineering/semiotic-eavt-services-section"]);
  const name = "@red-cup-engineering/semiotic-eavt-services-section";
  const response = await f.publish(await readFile(real("semiotic-eavt-services-section-0.1.4.tgz")));
  assert.equal(response.status, 400);
  const { error, violations } = await response.json();
  assert.equal(violations.length, 1, error);
  assert.equal(violations[0].kind, "dependency-subpath");
  assert.equal(violations[0].version, "0.1.4");
  assert.match(error, /^@red-cup-engineering\/semiotic-eavt-services-section was not published: the publish gate found 1 problem in what it ships/u);
  assert.match(error, /src\/identity\/artifact\.mjs:8 imports "@red-cup-engineering\/computer-content-address-engineering-services-section\/semantic-content-identity", but @red-cup-engineering\/computer-content-address-engineering-services-section@0\.2\.0 \(the highest published version satisfying "0\.2\.0"\) does not export "\.\/semantic-content-identity"/u);
  await noPackage(f, name);
});

test("semiotic-eavt-services-section 0.1.5, as published, is accepted", async (t) => {
  const f = await stockedFixture(t, ["@red-cup-engineering/semiotic-eavt-services-section"]);
  const response = await f.publish(await readFile(real("semiotic-eavt-services-section-0.1.5.tgz")));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  assert.equal((await f.request("/@red-cup-engineering/semiotic-eavt-services-section/0.1.5")).status, 200);
});

// kalshi-services-section 0.1.31 is a 102-file, 27-dependency package; every export and bin target is shipped and
// every other house import it makes resolves. The gate finds one thing: scripts/kalshi-books.mjs imports
// @red-cup-engineering/farolfi, which the package does not declare. The script is run from a checkout, where the
// workspace supplies farolfi; from an installed tarball it would fail to load.
test("kalshi-services-section 0.1.31 holds together except for the farolfi import its books script does not declare", async (t) => {
  const f = await stockedFixture(t);
  const bytes = await readFile(real("kalshi-services-section-0.1.31.tgz"));
  const refused = await f.publish(bytes);
  assert.equal(refused.status, 400);
  const { violations } = await refused.json();
  assert.deepEqual(violations.map(({ kind, message }) => [kind, message]), [[
    "undeclared-import",
    'scripts/kalshi-books.mjs:5 imports "@red-cup-engineering/farolfi/ledger/reports", but @red-cup-engineering/farolfi is not in dependencies, peerDependencies or optionalDependencies',
  ]]);
  // declared, it is accepted: farolfi 0.6.2 exports ./ledger/reports
  const files = Object.fromEntries([...readTarball(bytes)]);
  const manifest = JSON.parse(files["package.json"]);
  manifest.dependencies["@red-cup-engineering/farolfi"] = "0.6.2";
  const declared = packTarball({ ...files, "package.json": JSON.stringify(manifest) });
  const accepted = await f.publish(declared);
  assert.equal(accepted.status, 201, JSON.stringify(await accepted.clone().json()));
  // and declared at a version that predates the subpath, it is refused again, for that
  manifest.dependencies["@red-cup-engineering/farolfi"] = "0.1.0";
  const old = await f.publish(packTarball({ ...files, "package.json": JSON.stringify({ ...manifest, version: "0.1.32" }) }));
  assert.equal(old.status, 400);
  assert.match((await old.json()).error, /\[dependency-subpath\].*farolfi@0\.1\.0 .*does not export "\.\/ledger\/reports"/u);
});

test("a refused publish lists every problem of every version and stores nothing", async (t) => {
  const f = await registryFixture(t);
  const name = "@registry-fixture/capability";
  const good = packagedVersion(name, "1.0.0");
  const bad = (version) => packagedVersion(name, version, { manifest: { bin: { c: "./bin/c.mjs" }, exports: { ".": "./index.mjs", "./gone": "./gone.mjs" } }, files: { "a.mjs": 'import "@registry-fixture/missing";' } });
  const body = publishBody(good);
  const second = publishBody(bad("1.0.1"));
  body.versions["1.0.1"] = second.versions["1.0.1"];
  Object.assign(body._attachments, second._attachments);
  const response = await f.put(name, body);
  assert.equal(response.status, 400);
  const { error, violations } = await response.json();
  assert.deepEqual(violations.map(({ version, kind }) => `${version} ${kind}`).sort(), ["1.0.1 bin-target", "1.0.1 export-target", "1.0.1 undeclared-import"]);
  assert.match(error, /found 3 problems/u);
  for (const line of error.split("\n").slice(1)) assert.match(line, /^  - \[[a-z-]+\] @registry-fixture\/capability@1\.0\.1: /u);
  await noPackage(f, name);
});

test("a package may depend on, and import from, what this registry has published", async (t) => {
  const f = await registryFixture(t);
  assert.equal((await f.publish(packagedVersion("@registry-fixture/base", "1.0.0", { manifest: { exports: { ".": "./index.mjs", "./util": "./util.mjs" } }, files: { "util.mjs": "export {};\n" } }))).status, 201);
  const user = (version, specifier, range = "^1.0.0") => packagedVersion("@registry-fixture/user", version, { manifest: { dependencies: { "@registry-fixture/base": range } }, files: { "a.mjs": `import ${JSON.stringify(specifier)};\n` } });
  assert.equal((await f.publish(user("1.0.0", "@registry-fixture/base/util"))).status, 201);
  const missingSubpath = await f.publish(user("1.0.1", "@registry-fixture/base/nope"));
  assert.equal(missingSubpath.status, 400);
  assert.match((await missingSubpath.json()).error, /@registry-fixture\/base@1\.0\.0 \(the highest published version satisfying "\^1\.0\.0"\) does not export "\.\/nope"/u);
  const unpublishedRange = await f.publish(user("1.0.1", "@registry-fixture/base/util", "^2.0.0"));
  assert.equal(unpublishedRange.status, 400);
  assert.match((await unpublishedRange.json()).error, /\[dependency\].*no published version satisfies "\^2\.0\.0" \(newest published: 1\.0\.0\)/u);
});

test("the gate can be switched off for a registry that only mirrors", async (t) => {
  const f = await registryFixture(t, { publishGate: false });
  assert.equal((await f.publish(packagedVersion("@registry-fixture/capability", "1.0.0", { files: { "a.mjs": 'import "@registry-fixture/missing";' } }))).status, 201);
});

test("real npm publish shows the publisher the refusal, and a corrected package then publishes", { timeout: 120_000 }, async (t) => {
  const f = await liveRegistry(t);
  await f.publishPackage("@registry-fixture/base", "1.0.0", {}, { exports: { ".": "./index.mjs" } });
  const refused = f.publishPackage("@registry-fixture/user", "1.0.0", {}, { exports: { ".": "./index.mjs", "./cli": "./cli.mjs" }, bin: { user: "./cli.mjs" } });
  await assert.rejects(refused, (error) => /E400/u.test(error.stderr) && /publish gate found 2 problems/u.test(error.stderr)
    && /\[export-target\].*exports\["\.\/cli"\] -> \.\/cli\.mjs is not in the tarball/u.test(error.stderr) && /\[bin-target\]/u.test(error.stderr));
  assert.equal((await fetch(`${f.origin}/@registry-fixture%2fuser`)).status, 404);
  await f.publishPackage("@registry-fixture/user", "1.0.0", {}, { exports: { ".": "./index.mjs" } });
  assert.equal((await fetch(`${f.origin}/@registry-fixture%2fuser/1.0.0`)).status, 200);
});
