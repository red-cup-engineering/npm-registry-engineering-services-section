#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { auditRegistryCarrierImports } from "../src/registry-carrier-imports.mjs";
const [input, metadata, directory, output] = process.argv.slice(2);
if (!input || !metadata || !directory || !output) throw new Error("expected artifact receipt, existing supplier metadata, scratch directory and output receipt");
const packed = JSON.parse(await readFile(input, "utf8")), existing = JSON.parse(await readFile(metadata, "utf8"));
const receipt = await auditRegistryCarrierImports({ packed, existing, directory, onProgress: async receipt => {
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
} });
console.log(JSON.stringify({ packages: receipt.packages.length, findings: receipt.findings.length }));
if (receipt.findings.length) process.exitCode = 1;
