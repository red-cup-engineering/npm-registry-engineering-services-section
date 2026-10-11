import assert from "node:assert/strict";
import { test } from "node:test";
import { planZeroMajorVersionMap, rewriteZeroMajorCarrier } from "../src/zero-major-version-reset.mjs";

test("version reset maps every historical 1.x base below one, together with prereleases and without collisions", () => {
  assert.deepEqual(planZeroMajorVersionMap(["0.0.0", "0.1.0", "1.0.0-dev.0", "1.0.0", "2.0.0", "2.0.0-rc.1"]), [
    { from: "1.0.0-dev.0", to: "0.2.0-dev.0" }, { from: "1.0.0", to: "0.2.0" },
    { from: "2.0.0-rc.1", to: "0.3.0-rc.1" }, { from: "2.0.0", to: "0.3.0" },
  ]);
});

test('reset binds stale lock roots to the actual package even when its identity is already below one',()=>{
 const result=rewriteZeroMajorCarrier({manifest:{name:'@house/a',version:'0.3.0'},packageLock:{name:'@house/a',version:'1.0.0',packages:{'':{version:'1.0.0'}}}},new Map());
 assert.equal(result.packageLock.version,'0.3.0');assert.equal(result.packageLock.packages[''].version,'0.3.0');
});

test("version reset rewrites package identities and only exact house references", () => {
  const maps = new Map([["@house/leaf", new Map([["1.0.0", "0.1.0"]])], ["@house/root", new Map([["2.0.0", "0.2.0"]])]]);
  const result = rewriteZeroMajorCarrier({
    manifest: { name: "@house/root", version: "2.0.0", dependencies: { "@house/leaf": "1.0.0", semver: "7.7.2" }, overrides: { "@house/leaf": "1.0.0" } },
    packageLock: { lockfileVersion: 3, packages: { "": { name: "@house/root", version: "2.0.0", dependencies: { "@house/leaf": "1.0.0" } }, "node_modules/@house/leaf": { name: "@house/leaf", version: "1.0.0", resolved: "https://registry.example/@house/leaf/-/leaf-1.0.0.tgz", integrity: "sha512-old" }, "node_modules/semver": { name: "semver", version: "7.7.2", integrity: "sha512-third-party" } } },
  }, maps);
  assert.equal(result.manifest.version, "0.2.0");
  assert.equal(result.manifest.dependencies["@house/leaf"], "0.1.0");
  assert.equal(result.manifest.dependencies.semver, "7.7.2");
  assert.equal(result.packageLock.packages[""].version, "0.2.0");
  assert.equal(result.packageLock.packages["node_modules/@house/leaf"].version, "0.1.0");
  assert.equal(result.packageLock.packages["node_modules/@house/leaf"].integrity, undefined);
  assert.equal(result.packageLock.packages["node_modules/@house/leaf"].resolved, undefined);
  assert.equal(result.packageLock.packages["node_modules/semver"].integrity, "sha512-third-party");
});
