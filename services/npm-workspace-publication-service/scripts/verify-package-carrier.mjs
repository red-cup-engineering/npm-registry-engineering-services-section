#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyIsolatedCarrier } from "../src/isolated-carrier-verification.mjs";
import { requiredArgument } from "@red-cup-engineering/javascript-node-services-section/argv";

const args = process.argv.slice(2);

const sourceDir = resolve(requiredArgument("--package-dir", args));
const registry = requiredArgument("--registry", args);
const manifest = JSON.parse(await readFile(resolve(sourceDir, "package.json"), "utf8"));
let verified;
try {
  verified = await verifyIsolatedCarrier({ sourceDir, manifest, registry });
  process.stdout.write(`${JSON.stringify({ outcome: "isolated-carrier-verified", name: manifest.name, version: manifest.version })}\n`);
} catch (error) {
  const reason = [error?.stderr, error?.stdout, error?.message].map((part) => String(part ?? "").trim()).filter(Boolean).join(" | ");
  process.stdout.write(`${JSON.stringify({ outcome: "isolated-carrier-refused", name: manifest.name ?? null, version: manifest.version ?? null, reason: reason.slice(-12_000), ...(error?.evidence === undefined ? {} : { evidence: error.evidence }) })}\n`);
  process.exitCode = 1;
} finally {
  await verified?.cleanup();
}
