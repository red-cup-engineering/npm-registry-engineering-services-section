#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { serveNpmRegistryRead } from "../src/npm-registry-read-service.mjs";

export async function isMainModule({ argv = process.argv, moduleUrl = import.meta.url, resolveRealpath = realpath } = {}) {
  if (!argv[1]) return false;
  try {
    return pathToFileURL(await resolveRealpath(argv[1])).href === moduleUrl;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await serveNpmRegistryRead(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (await isMainModule()) {
  await main();
}
