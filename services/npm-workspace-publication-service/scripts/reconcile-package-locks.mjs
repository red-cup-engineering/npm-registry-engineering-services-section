#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { reconcilePackageLocks } from "../src/reconcile-package-locks.mjs";
import { requiredArgument } from "@red-cup-engineering/javascript-node-services-section/argv";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const receipt = await reconcilePackageLocks({
    workspaceRoot: requiredArgument("--workspace"),
    roots: JSON.parse(await readFile(requiredArgument("--roots"), "utf8")),
    registry: requiredArgument("--registry"),
    token: process.env.NODE_AUTH_TOKEN,
    concurrency: process.argv.includes("--concurrency") ? Number(requiredArgument("--concurrency")) : 4,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
