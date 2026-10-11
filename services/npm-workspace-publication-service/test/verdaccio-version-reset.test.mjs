import assert from "node:assert/strict";
import { test } from "node:test";
import { planVerdaccioZeroMajorVersionReset, rewriteVerdaccioPackument } from "../src/verdaccio-version-reset.mjs";

test("Verdaccio reset derives every mapping from the complete historical packument", () => {
  const plan = planVerdaccioZeroMajorVersionReset([{ name: "@house/leaf", versions: { "0.2.0": {}, "1.0.0": {}, "1.0.1": {} } }]);
  assert.deepEqual(plan.mappings, [{ name: "@house/leaf", from: "1.0.0", to: "0.3.0" }, { name: "@house/leaf", from: "1.0.1", to: "0.4.0" }]);
});

test("Verdaccio reset changes version keys, tags, house references, and integrity only from staged tarballs", () => {
  const maps = new Map([["@house/leaf", new Map([["1.0.0", "0.1.0"]])], ["@house/root", new Map([["1.0.0", "0.1.0"]])]]);
  const artifacts = new Map([["@house/root\u00001.0.0", { version: "0.1.0", filename: "root-0.1.0.tgz", tarball: "https://registry/@house/root/-/root-0.1.0.tgz", integrity: "sha512-new", shasum: "new" }]]);
  const output = rewriteVerdaccioPackument({ name: "@house/root", versions: { "1.0.0": { name: "@house/root", version: "1.0.0", dependencies: { "@house/leaf": "1.0.0", }, dist: { tarball: "https://registry/@house/root/-/root-1.0.0.tgz", integrity: "sha512-old" } } }, "dist-tags": { latest: "1.0.0" }, time: { created: "now", "1.0.0": "then" }, _attachments: { "root-1.0.0.tgz": { shasum: "old", version: "1.0.0" } } }, maps, { artifacts });
  assert.equal(output.versions["0.1.0"].dependencies["@house/leaf"], "0.1.0");
  assert.equal(output.versions["0.1.0"].dist.integrity, "sha512-new");
  assert.equal(output["dist-tags"].latest, "0.1.0");
  assert.equal(output.time["0.1.0"], "then");
  assert.equal(output.versions["1.0.0"], undefined);
  assert.deepEqual(output._attachments["root-0.1.0.tgz"], { shasum: "new", version: "0.1.0" });
  assert.throws(() => rewriteVerdaccioPackument({ name: "@house/root", versions: { "1.0.0": { name: "@house/root", version: "1.0.0" } } }, maps), /requires staged tarball integrity/u);
});
