import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPublication } from "../src/publish-gate.mjs";

const name = "@red-cup-engineering/range-receiver";
const supplier = "@red-cup-engineering/range-supplier";
const version = "1.0.0";
const shape = { ".": "./index.mjs", "./values": "./values.mjs" };
const incompatible = { ".": "./index.mjs" };
function tryPublication(range, { versions, tags = {}, publishedManifest, readHistory = () => {}, optional = false }) {
  const scratch = mkdtempSync(join(tmpdir(), "registry-range-test-"));
  const cwd = join(scratch, "fixture");
  try {
    mkdirSync(cwd);
    const peer = optional ? { peerDependencies: { [supplier]: range }, peerDependenciesMeta: { [supplier]: { optional: true } } } :
      { dependencies: { [supplier]: range } };
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name, version, exports: "./consumer.mjs", ...peer }));
    writeFileSync(join(cwd, "consumer.mjs"), `export * from "${supplier}/values";\n`);
    const [archive] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--offline", "--cache", join(scratch, "npm-cache")], { cwd, encoding: "utf8" }));
    return checkPublication({
      name, version, bytes: readFileSync(join(cwd, archive.filename)),
      publishedPackument: dependency => {
        assert.equal(dependency, supplier);
        readHistory();
        return { versions: Object.fromEntries(Object.entries(versions).map(([version, exports]) => [version, { exports }])), "dist-tags": tags };
      },
      publishedManifest,
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test("a new export cannot hide an incompatible published floor", async () => {
  const versions = { "0.18.1": shape, "0.18.0": incompatible };
  const violations = await tryPublication("^0.18.0", { versions });
  assert.deepEqual(violations.map(({ kind }) => kind), ["dependency-subpath"]);
  assert.match(violations[0].message, /@0\.18\.0\b/u);
  assert.deepEqual(await tryPublication("^0.18.1", { versions }), []);
});

test("a missing export in a middle release or a second comparator set is also incompatible", async () => {
  for (const range of ["^1.0.0", "1.0.0 || 1.1.0 || 1.2.0"]) {
    const violations = await tryPublication(range, { versions: { "1.2.0": shape, "1.0.0": shape, "1.1.0": incompatible } });
    assert.deepEqual(violations.map(({ kind }) => kind), ["dependency-subpath"]);
    assert.match(violations[0].message, /@1\.1\.0\b/u);
  }
});

test("the stable range excludes prereleases, but an explicit prerelease comparator includes one", async () => {
  const versions = { "1.1.0": shape, "1.0.0": shape, "1.1.0-dev.0": incompatible };
  assert.deepEqual(await tryPublication("^1.0.0", { versions }), []);
  const violations = await tryPublication("^1.0.0 || 1.1.0-dev.0", { versions });
  assert.equal(violations[0]?.kind, "dependency-subpath");
  assert.match(violations[0].message, /@1\.1\.0-dev\.0\b/u);
});

test("a tag selects one version, exact resolution does not read history on success, and optional peers may be absent", async () => {
  const versions = { "1.0.0": incompatible, "1.1.0": shape };
  assert.deepEqual(await tryPublication("latest", { versions, tags: { latest: "1.1.0" } }), []);
  let exactReads = 0;
  assert.deepEqual(await tryPublication("1.1.0", {
    versions: {},
    readHistory: () => assert.fail("exact admitted reads must not fetch supplier history"),
    publishedManifest: (name, version) => {
      exactReads++;
      assert.equal(name, supplier);
      assert.equal(version, "1.1.0");
      return { name, version, exports: shape };
    },
  }), []);
  assert.equal(exactReads, 1);
  assert.deepEqual(await tryPublication("^2.0.0", { versions, optional: true }), []);
  assert.equal((await tryPublication("^2.0.0", { versions }))[0]?.kind, "dependency");
});
