#!/usr/bin/env node
import { deriveStaleInstallTreesReport, removePruneTrees } from "../src/stale-install-trees.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const root = option("--root", null);
if (!root) throw new Error("--root <dir> is required");
const days = Number.parseInt(option("--days", "30"), 10);
if (!Number.isSafeInteger(days) || days < 0) throw new TypeError("--days must be a nonnegative integer");
const format = option("--format", "json");
if (format !== "json") throw new TypeError("--format must be json");
const apply = args.includes("--apply");
const unitsDirOption = option("--units-dir", undefined);
const mcpConfigOption = option("--mcp-config", undefined);

const reportInput = { root, days };
if (unitsDirOption !== undefined) reportInput.unitsDir = unitsDirOption;
if (mcpConfigOption !== undefined) reportInput.mcpConfigPath = mcpConfigOption;

const report = await deriveStaleInstallTreesReport(reportInput);

if (!apply) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const outcome = await removePruneTrees(report.trees);
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}
