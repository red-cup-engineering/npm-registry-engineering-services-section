#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { executeRelationalOperationMessage } from "@red-cup-engineering/a2a-sovereign-operation-boundary-service";
import { registrySnapshotProtocol } from "../src/protocol.mjs";
import { obtainRegistrySnapshot } from "../src/snapshot.mjs";

const operations = Object.freeze({ "obtain-package-registry-snapshot": obtainRegistrySnapshot });

// This package translates messages; it does not know where a registry lives
// or how one is served. Whoever runs an A2A face for a registry supplies both.
export function executeA2aMessage(source, environment = process.env) {
  const registryRoot = environment.REGISTRY_ROOT;
  const registryUrl = environment.REGISTRY_URL;
  if (!registryRoot || !registryUrl) throw new Error("REGISTRY_ROOT and REGISTRY_URL are required");
  return executeRelationalOperationMessage(source, {
    protocol: registrySnapshotProtocol,
    operations,
    runtimeLoader: async () => Object.freeze({ registryRoot, registryUrl }),
    responseFilename: "package-registry-snapshot.rmn.cbor",
    unknownOperationMessage: "unknown package registry operation",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await executeA2aMessage(JSON.parse(readFileSync(0, "utf8"))))}\n`); }
  catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; }
}
