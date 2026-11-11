#!/usr/bin/env node
import { discoverDecommissionedPackages } from "../src/decommissioned-package-candidates.mjs";
import { argument, requiredArgument } from "@red-cup-engineering/javascript-node-services-section/argv";

const root = requiredArgument("--root");
const format = argument("--format") ?? "summary";
const report = await discoverDecommissionedPackages({ root });

if (format === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (format === "summary") {
  process.stdout.write(`${JSON.stringify({ kind: report.kind, root: report.root, keyword: report.keyword, candidates: report.candidates.length }, null, 2)}\n`);
} else {
  throw new Error(`unknown --format: ${format}`);
}
