#!/usr/bin/env node
import { resolve } from "node:path";

import { auditOwnerNamespaceDebt } from "../src/owner-namespace-debt.mjs";
import { scanWorkspaceManifests } from "../src/read-workspace-manifests.mjs";

function servicesRoot(argv) {
  const index = argv.indexOf("--services-root");
  if (index === -1) return resolve(process.cwd(), "lib/emsenn/services/561-group/services");
  if (argv[index + 1] === undefined) throw new TypeError("--services-root requires a path");
  return resolve(argv[index + 1]);
}

try {
  const report = await auditOwnerNamespaceDebt(servicesRoot(process.argv.slice(2)), { scan: scanWorkspaceManifests });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.summary.violations > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
