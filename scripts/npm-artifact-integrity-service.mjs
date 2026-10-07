import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const MEASUREMENT_FIELDS = ["bytes", "shasum", "integrity"];

function artifactBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("artifact bytes must be a Buffer or Uint8Array");
}

function expectedMeasurement(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected artifact measurement must be an object");
  }
  const fields = MEASUREMENT_FIELDS.filter((field) => Object.hasOwn(value, field));
  if (fields.length === 0) throw new TypeError("expected artifact measurement must include bytes, shasum, or integrity");
  return fields;
}

export function measureArtifactBytes(value) {
  const bytes = artifactBytes(value);
  return Object.freeze({
    bytes: bytes.byteLength,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  });
}

export async function measureArtifactFile(path) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("artifact file path must be a non-empty string");
  return measureArtifactBytes(await readFile(path));
}

export function verifyArtifactBytes(value, expected) {
  const fields = expectedMeasurement(expected);
  const measurement = measureArtifactBytes(value);
  const mismatches = fields.filter((field) => measurement[field] !== expected[field]);
  return Object.freeze({
    ok: mismatches.length === 0,
    measurement,
    mismatches: Object.freeze(mismatches),
  });
}

export async function verifyArtifactFile(path, expected) {
  const fields = expectedMeasurement(expected);
  const measurement = await measureArtifactFile(path);
  const mismatches = fields.filter((field) => measurement[field] !== expected[field]);
  return Object.freeze({
    ok: mismatches.length === 0,
    measurement,
    mismatches: Object.freeze(mismatches),
  });
}
