#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { receiveSourceRegistryConsumers } from "../src/source-registry-closure.mjs";

const [input, logDirectory, output] = process.argv.slice(2);
if (!input || !logDirectory || !output) throw new Error("expected explicit consumers and received releases JSON, log directory and output receipt");
const selection = JSON.parse(await readFile(input, "utf8"));
const receipt = await receiveSourceRegistryConsumers({ ...selection, logDirectory, onProgress: async (receipt, name) => {
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ installed: receipt.packages.length, refused: receipt.refusals.length, name }));
} });
if (receipt.refusals.length) process.exitCode = 1;
