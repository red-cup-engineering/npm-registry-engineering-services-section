import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SECRET_PATH, correctedTarballURL, secretBearingContentPaths } from "../src/tarball-guard.mjs";

test("scoped tarball URL corruption (name duplicated after /-/) is corrected", () => {
  const corrupted = "http://127.0.0.1:4873/@red-cup-engineering/create-markdown-document-service/-/@red-cup-engineering/create-markdown-document-service-0.1.0.tgz";
  const expected = "http://127.0.0.1:4873/@red-cup-engineering/create-markdown-document-service/-/create-markdown-document-service-0.1.0.tgz";
  assert.equal(correctedTarballURL(corrupted, "@red-cup-engineering/create-markdown-document-service"), expected);
});

test("a well-formed scoped tarball URL is left alone", () => {
  const wellFormed = "http://127.0.0.1:4873/@red-cup-engineering/create-markdown-document-service/-/create-markdown-document-service-0.1.0.tgz";
  assert.equal(correctedTarballURL(wellFormed, "@red-cup-engineering/create-markdown-document-service"), null);
});

test("a well-formed unscoped tarball URL is left alone (idempotent under repeated repair)", () => {
  const wellFormed = "http://127.0.0.1:4873/left-pad/-/left-pad-1.0.0.tgz";
  const once = correctedTarballURL(wellFormed, "left-pad");
  assert.equal(once === null || once === wellFormed, true);
});

test("a well-formed unscoped tarball URL is not flagged as corrupted (regression: /-/name-name-version legitimately occurs)", () => {
  // Unscoped packages legitimately produce a `/-/${name}-${version}.tgz` tail
  // that is textually indistinguishable from the corruption marker; the
  // repair must recognize this is already correct and report no change.
  assert.equal(correctedTarballURL("http://127.0.0.1:4873/which/-/which-1.0.0.tgz", "which"), null);
  assert.equal(correctedTarballURL("http://127.0.0.1:4873/word-wrap/-/word-wrap-1.2.5.tgz", "word-wrap"), null);
});

test("a missing or malformed tarball URL is left alone", () => {
  assert.equal(correctedTarballURL(undefined, "@scope/name"), null);
  assert.equal(correctedTarballURL("", "@scope/name"), null);
  assert.equal(correctedTarballURL("not-a-corrupted-shape.tgz", "@scope/name"), null);
});

test("credential carriers are flagged", () => {
  for (const path of [
    "data/agent-card-signing/ed25519-private.pem",
    "data/credentials/portfolio-status-agent-card.pkcs8.pem",
    "content/c2pa-signing-chain.pem",
    ".env",
    ".env.production",
    "config/.env.local",
    "id_rsa",
    "keys/id_ed25519.pub",
    "content/config/credential-provisioning.json",
    "ops/service-account-secret.txt",
    "auth/keystore.jks",
  ]) {
    assert.equal(SECRET_PATH.test(path), true, `${path} should be flagged`);
  }
});

test("ordinary paths and known non-secrets pass", () => {
  for (const path of [
    "src/index.mjs",
    "package.json",
    ".env.example",
    "content/professional-repertoire/offices/corporate-secretary.json",
    "content/text/documents/notes/2026-06-25-research-on-verifiable-credentials.md",
    "data/environment.md",
  ]) {
    assert.equal(SECRET_PATH.test(path), false, `${path} should pass`);
  }
});

test("final carrier bytes refuse a private key generated under a benign path", async () => {
  const root = await mkdtemp(join(tmpdir(), "carrier-secret-content-"));
  try {
    await mkdir(join(root, "dist"));
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(join(root, "dist/config.txt"), privateKey.export({ type: "pkcs8", format: "pem" }));
    assert.deepEqual(await secretBearingContentPaths(root, ["dist/config.txt"]), ["dist/config.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source literals describing JOSE and PEM grammar are not private-key material", async () => {
  const root = await mkdtemp(join(tmpdir(), "carrier-benign-content-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/jose.mjs"), `export const example = { kty: "OKP", crv: "Ed25519", x: "public" }; export const fake = \`-----BEGIN PRIVATE KEY-----\n${"A".repeat(80)}\n-----END PRIVATE KEY-----\`;\n`);
    await writeFile(join(root, "src/jwk.txt"), '{"kty":"OKP","d":"documentation-placeholder"}\n');
    assert.deepEqual(await secretBearingContentPaths(root, ["src/jose.mjs", "src/jwk.txt"]), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private JWK material is refused regardless of filename suffix", async () => {
  const root = await mkdtemp(join(tmpdir(), "carrier-jwk-content-"));
  try {
    await mkdir(join(root, "dist"));
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(join(root, "dist/material.txt"), `${JSON.stringify(privateKey.export({ format: "jwk" }))}\n`);
    assert.deepEqual(await secretBearingContentPaths(root, ["dist/material.txt"]), ["dist/material.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
