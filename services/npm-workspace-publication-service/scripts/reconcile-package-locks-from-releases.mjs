#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { reconcilePackageLocksFromReleases } from "../src/reconcile-package-locks-from-releases.mjs";
import { reconcilePackageLocks } from "../src/reconcile-package-locks.mjs";
import { requiredArgument } from "@red-cup-engineering/javascript-node-services-section/argv";

const receipt = await reconcilePackageLocksFromReleases({
  releases: JSON.parse(await readFile(requiredArgument("--releases"), "utf8")),
  snapshotDirectory: requiredArgument("--snapshot"),
  workspaceRoot: requiredArgument("--workspace"),
  roots: JSON.parse(await readFile(requiredArgument("--roots"), "utf8")),
  registry: requiredArgument("--registry"),
  reconcile: reconcilePackageLocks,
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
