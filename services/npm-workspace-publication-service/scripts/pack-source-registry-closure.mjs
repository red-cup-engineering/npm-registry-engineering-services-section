#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { packSourceRegistryClosure } from "../src/source-registry-closure.mjs";

const [input, destination, output] = process.argv.slice(2);
if (!input || !destination || !output) throw new Error("expected admitted plan, artifact directory and receipt path");
const plan = JSON.parse(await readFile(input, "utf8"));
const receipt = await packSourceRegistryClosure(plan, { destination, onProgress: async (receipt, name) => {
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ packed: receipt.packages.length, name, refusals: receipt.refusals.length }));
} });
if (receipt.refusals.length) process.exitCode = 1;
