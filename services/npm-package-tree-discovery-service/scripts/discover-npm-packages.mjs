#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { discoverPackages, loadIgnoreDirectoryNames } from "../src/discover-npm-packages.mjs";
import { argument, repeatedArgument, requiredArgument } from "@red-cup-engineering/javascript-node-services-section/argv";

const root = requiredArgument("--root");
const ignoreFiles = repeatedArgument("--ignore-file");
const ignoreDirectoryNames = (await Promise.all(ignoreFiles.map((path) => loadIgnoreDirectoryNames(path)))).flat();
const report = await discoverPackages({ root, ignoreDirectoryNames });
const format = argument("--format") ?? "summary";
const output = argument("--output");

if (report.collisions.length > 0) {
  for (const collision of report.collisions) {
    process.stderr.write(`npm package tree discovery collision: ${collision.identity} at ${collision.directories.join(", ")}\n`);
  }
  process.exitCode = 1;
}

if (output !== undefined) {
  await writeFile(output, `${JSON.stringify(report.found.map((row) => row.directory), null, 2)}\n`);
}

if (format === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (format === "list") {
  process.stdout.write(`${JSON.stringify(report.found.map((row) => row.directory), null, 2)}\n`);
} else if (format === "summary") {
  const skippedByReason = Object.groupBy(report.skipped, (row) => row.reason.split(":")[0]);
  process.stdout.write(`${JSON.stringify({
    type: report.type,
    root: report.root,
    found: report.found.length,
    skipped: report.skipped.length,
    skippedByReason: Object.fromEntries(Object.entries(skippedByReason).map(([reason, rows]) => [reason, rows.length])),
    collisions: report.collisions.length,
  }, null, 2)}\n`);
} else {
  throw new Error(`unknown --format: ${format}`);
}
