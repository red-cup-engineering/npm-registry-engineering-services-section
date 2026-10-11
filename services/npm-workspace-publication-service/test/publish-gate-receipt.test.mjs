import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPublishGateReceipt } from "../src/publish-gate-receipt.mjs";

const BASE = {
  package: "@red-cup-engineering/example",
  action: "publish",
  date: "2026-09-03",
  fromVersion: "0.1.0",
  toVersion: "0.1.1",
  freshInstallTestCount: { tests: 5, pass: 5, fail: 0 },
  freshInstallLockfileCheck: { resolvedTotal: 3, canonical: 3, notCanonicalRegistry: 0, houseScopedNotCanonical: 0 },
  tarballDiffClassification: "additive",
};

test("assembles the standard receipt shape", () => {
  const record = buildPublishGateReceipt(BASE);
  assert.equal(record.package, BASE.package);
  assert.equal(record.action, "publish");
  assert.equal(record.toVersion, "0.1.1");
  assert.deepEqual(record.freshInstallTestCount, { tests: 5, pass: 5, fail: 0 });
  assert.equal(record.tarballDiffClassification, "additive");
});

test("a refusal carries a null toVersion by default and merges extra fields", () => {
  const record = buildPublishGateReceipt({ ...BASE, action: "refusal", toVersion: null, extra: { refusalStep: 1, refusalReason: "tests failed" } });
  assert.equal(record.toVersion, null);
  assert.equal(record.refusalStep, 1);
  assert.equal(record.refusalReason, "tests failed");
});

test("rejects an unrecognized action", () => {
  assert.throws(() => buildPublishGateReceipt({ ...BASE, action: "delete" }), TypeError);
});

test("rejects a malformed date", () => {
  assert.throws(() => buildPublishGateReceipt({ ...BASE, date: "09-03-2026" }), TypeError);
});

test("rejects a non-numeric test count", () => {
  assert.throws(() => buildPublishGateReceipt({ ...BASE, freshInstallTestCount: { tests: "5", pass: 5, fail: 0 } }), TypeError);
});

test("rejects an unrecognized tarball diff classification", () => {
  assert.throws(() => buildPublishGateReceipt({ ...BASE, tarballDiffClassification: "unknown" }), TypeError);
});

test("the returned record is frozen", () => {
  const record = buildPublishGateReceipt(BASE);
  assert.throws(() => { record.package = "changed"; }, TypeError);
});
