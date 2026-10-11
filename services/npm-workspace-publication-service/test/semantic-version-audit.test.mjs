import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditSemanticVersionPolicy, summarizeSemanticVersionPolicyAudit } from "../src/semantic-version-audit.mjs";

function writeManifest(root, name, manifest, lock) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  if (lock) writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
}

test("forms one bounded deterministic summary of a semantic-version estate audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-version-audit-"));
  writeManifest(root, "stable", { name: "stable", version: "0.1.0", exports: "./index.mjs" });
  writeManifest(root, "invalid", { name: "invalid", version: "1.0", exports: "./index.mjs" });
  writeManifest(root, "section", { name: "section", description: "metadata only" });

  const audit = await auditSemanticVersionPolicy(root);
  const summary = summarizeSemanticVersionPolicyAudit(audit, { sampleLimit: 1 });

  assert.equal(summary.scanned, 3);
  assert.equal(summary.exempt, 1);
  assert.equal(summary.compliant, 1);
  assert.equal(summary.findingCount, 1);
  assert.equal(summary.violationCount, 1);
  assert.match(summary.findingsDigest, /^ni:\/\/\/sha-256;/u);
  assert.equal(summary.findingSamples.length, 1);
  assert.match(summary.reasonCounts[0].reason, /stable X\.Y\.Z/u);
});

test("summary sampling is bounded without changing the full finding commitment", async () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-version-audit-"));
  writeManifest(root, "one", { name: "one", version: "1", exports: "./index.mjs" });
  writeManifest(root, "two", { name: "two", version: "2", exports: "./index.mjs" });
  const audit = await auditSemanticVersionPolicy(root);
  const none = summarizeSemanticVersionPolicyAudit(audit, { sampleLimit: 0 });
  const both = summarizeSemanticVersionPolicyAudit(audit, { sampleLimit: 2 });
  assert.equal(none.findingSamples.length, 0);
  assert.equal(both.findingSamples.length, 2);
  assert.equal(none.findingsDigest, both.findingsDigest);
  assert.throws(() => summarizeSemanticVersionPolicyAudit(audit, { sampleLimit: -1 }), /nonnegative integer/u);
});

test("finding commitments are stable across checkout roots", async () => {
  const leftRoot = mkdtempSync(join(tmpdir(), "semantic-version-audit-left-"));
  const rightRoot = mkdtempSync(join(tmpdir(), "semantic-version-audit-right-"));
  for (const root of [leftRoot, rightRoot]) {
    writeManifest(root, "invalid", { name: "invalid", version: "1", exports: "./index.mjs" });
  }
  const left = summarizeSemanticVersionPolicyAudit(await auditSemanticVersionPolicy(leftRoot));
  const right = summarizeSemanticVersionPolicyAudit(await auditSemanticVersionPolicy(rightRoot));
  assert.equal(left.findingsDigest, right.findingsDigest);
  assert.equal(left.findingSamples[0].path, "invalid/package.json");
});

test("the live workspace audit excludes retained captures and package fixtures", async () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-version-audit-"));
  writeManifest(root, "live", { name: "live", version: "0.1.0", exports: "./index.mjs" });
  writeManifest(join(root, "data", "captures"), "retained", { name: "retained", version: "bad", exports: "./index.mjs" });
  writeManifest(join(root, "test", "fixtures"), "fixture", { name: "fixture", version: "bad", exports: "./index.mjs" });
  const audit = await auditSemanticVersionPolicy(root);
  assert.equal(audit.scanned, 1);
  assert.equal(audit.findings.length, 0);
});
