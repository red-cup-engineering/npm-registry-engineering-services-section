#!/usr/bin/env node
// CLI entrypoint for publishNpmRegistrySnapshot; argument parsing and I/O
// only, operation logic lives in ../src/publish-npm-registry-snapshot.mjs.
// Usage: node scripts/publish-npm-registry-snapshot.mjs --package <dir>
// [--package <dir> ...] --host <host-dir> --snapshot <name>
// --registry-url <url> [--base-snapshot <name>] [--concurrency <n>]

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runMain } from "@red-cup-engineering/javascript-file-services-section/javascript-file-main-guard";

import { publishNpmRegistrySnapshot } from "../src/publish-npm-registry-snapshot.mjs";

export { publishNpmRegistrySnapshot };

function usage() {
  return (
    "usage: publish-npm-registry-snapshot --package <dir> [--package <dir> ...] " +
    "--host <host-dir> --snapshot <name> --registry-url <url> [--base-snapshot <name>] [--concurrency <n>]\n"
  );
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      package: { type: "string", multiple: true, default: [] },
      host: { type: "string" },
      snapshot: { type: "string" },
      "registry-url": { type: "string" },
      "base-snapshot": { type: "string" },
      concurrency: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (values.package.length === 0 || !values.host || !values.snapshot || !values["registry-url"]) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }

  const receipt = await publishNpmRegistrySnapshot({
    packages: values.package,
    hostDirectory: values.host,
    snapshotName: values.snapshot,
    registryUrl: values["registry-url"],
    baseSnapshot: values["base-snapshot"],
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
  });
  process.stdout.write(`${JSON.stringify({ type: receipt.type, registry: receipt.registry, packageCount: receipt.packageCount, activation: receipt.activation }, null, 2)}\n`);
}

runMain(({ argv }) => main(argv), {
  moduleUrl: import.meta.url,
  isEntry: (url, entry) => resolve(fileURLToPath(url)) === resolve(entry ?? ""),
  formatError: (error) => `${error.message}\n`,
  exitCode: 1,
});
