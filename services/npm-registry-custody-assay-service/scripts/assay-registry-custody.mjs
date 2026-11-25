#!/usr/bin/env node
import { assayRegistryCustody, quarantineRegistryCustodyDefects } from "../src/index.mjs";
import { argument, repeatedArgument, requiredArgument } from "@red-cup-engineering/parse-javascript-argv-service";

const storageRoot = requiredArgument("--storage-root");
const ownedScopes = repeatedArgument("--owned-scope");
const dataRoot = argument("--data-root");
const dryRun = process.argv.includes("--dry-run");

const graph = await assayRegistryCustody({ storageRoot, ownedScopes });

let quarantine = null;
if (dataRoot !== undefined && !dryRun) {
  quarantine = quarantineRegistryCustodyDefects({ defects: graph.defects, dataRoot });
}

process.stdout.write(`${JSON.stringify({
  storageRoot: graph.storageRoot,
  ownedScopes: graph.ownedScopes,
  defects: graph.defects.length,
  defectsByKind: Object.fromEntries(
    [...new Set(graph.defects.map((defect) => defect.kind))]
      .sort()
      .map((kind) => [kind, graph.defects.filter((defect) => defect.kind === kind).length]),
  ),
  quarantine: quarantine === null ? null : { dataRoot, appended: quarantine.appended.length, alreadyQuarantined: quarantine.alreadyQuarantined.length },
}, null, 2)}\n`);

if (graph.defects.length > 0) {
  for (const defect of graph.defects) {
    process.stderr.write(`registry custody defect: ${defect.kind} -> ${defect.packageSurface}: ${defect.detail.reason}\n`);
  }
  process.exitCode = 1;
}
