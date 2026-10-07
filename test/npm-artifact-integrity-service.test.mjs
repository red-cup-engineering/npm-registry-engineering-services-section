import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  measureArtifactBytes,
  measureArtifactFile,
  verifyArtifactBytes,
  verifyArtifactFile,
} from "../scripts/npm-artifact-integrity-service.mjs";

const HELLO = Object.freeze({
  bytes: 5,
  shasum: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
  integrity: "sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==",
});

test("measures buffers and files using npm SHA-1 and SHA-512 SRI encodings", async () => {
  const bytes = Buffer.from("hello");
  const measured = measureArtifactBytes(bytes);
  assert.equal(measured.bytes, HELLO.bytes);
  assert.equal(measured.shasum, HELLO.shasum);
  assert.equal(measured.integrity, HELLO.integrity);
  const root = await mkdtemp(join(tmpdir(), "npm-artifact-integrity-"));
  try {
    const artifact = join(root, "artifact.tgz");
    await writeFile(artifact, bytes);
    assert.deepEqual(await measureArtifactFile(artifact), measured);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports deterministic mismatch fields without exposing artifact bytes", async () => {
  const expected = measureArtifactBytes(Buffer.from("expected"));
  const result = verifyArtifactBytes(Buffer.from("actual"), expected);
  assert.deepEqual(result.mismatches, ["bytes", "shasum", "integrity"]);
  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(result.measurement, "bytes"), true);
  const root = await mkdtemp(join(tmpdir(), "npm-artifact-integrity-"));
  try {
    const artifact = join(root, "artifact.tgz");
    await writeFile(artifact, "expected");
    assert.deepEqual(await verifyArtifactFile(artifact, expected), {
      ok: true,
      measurement: expected,
      mismatches: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsupported measurement inputs and reports malformed declared values as mismatches", () => {
  assert.throws(() => measureArtifactBytes("artifact"), /Buffer or Uint8Array/u);
  assert.throws(() => verifyArtifactBytes(Buffer.alloc(0), {}), /must include/u);
  assert.deepEqual(verifyArtifactBytes(Buffer.alloc(0), { shasum: "UPPERCASE" }).mismatches, ["shasum"]);
});
