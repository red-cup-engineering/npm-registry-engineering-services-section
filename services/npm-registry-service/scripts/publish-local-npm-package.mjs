#!/usr/bin/env node
// Deprecated compatibility name; publication is now immutable snapshot activation.
// Forwards to the package that owns it through a declared
// @scope/name@exact-version dependency, not a raw cross-package filesystem
// import, so the two entrypoints never drift.
import { parseArgs } from "node:util";

import { publishNpmRegistrySnapshot } from "@red-cup-engineering/npm-registry-snapshot-publication-service";

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      package: { type: "string", multiple: true, default: [] },
      host: { type: "string" },
      snapshot: { type: "string" },
      "registry-url": { type: "string" },
      "base-snapshot": { type: "string" },
      concurrency: { type: "string" },
    },
  });

  const receipt = await publishNpmRegistrySnapshot({
    packages: values.package,
    hostDirectory: values.host,
    snapshotName: values.snapshot,
    registryUrl: values["registry-url"],
    baseSnapshot: values["base-snapshot"],
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
  });
  process.stdout.write(`${JSON.stringify({ type: receipt.type, registry: receipt.registry, packageCount: receipt.packageCount, activation: receipt.activation }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
