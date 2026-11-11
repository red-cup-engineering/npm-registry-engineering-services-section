#!/usr/bin/env node
import { parseArgs } from "node:util";

import { observeRegistryDrift } from "../src/observe-registry-drift.mjs";

// "dist" joins node_modules/.git as a default exclude on evidence, not
// caution: at least one service section (web-services-section/relating)
// carries a build-output dist/ tree that mirrors its own services/
// directory file-for-file, including package.json — the walker sees both
// as distinct packages with the same name@version, and the registry
// builder correctly refuses that as a duplicate-package-version collision.
// pnpm-workspace.yaml already excludes dist/ from workspace linking for
// the same reason.
const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist"];

function usage() {
  return "usage: observe-registry-drift --root <path> --registry-url <url> [--exclude <segment>]... [--no-default-excludes] [--format ndjson|json|summary] [--strict]";
}

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    "registry-url": { type: "string" },
    exclude: { type: "string", multiple: true, default: [] },
    "no-default-excludes": { type: "boolean", default: false },
    format: { type: "string", default: "ndjson" },
    strict: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

if (!values.root || !values["registry-url"] || !["ndjson", "json", "summary"].includes(values.format)) {
  console.error(usage());
  process.exit(2);
}

const excludes = [...values.exclude];
if (!values["no-default-excludes"]) excludes.push(...DEFAULT_EXCLUDES);

const observation = await observeRegistryDrift({
  root: values.root,
  excludes,
  registryUrl: values["registry-url"],
});

if (values.format === "json") {
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
} else if (values.format === "summary") {
  process.stdout.write(`${JSON.stringify({
    type: observation.type,
    root: observation.root,
    registry: observation.registry,
    packages: observation.findings.length,
    counts: observation.counts,
    diskDefects: observation.diskDefects.length,
    receiptFound: observation.receiptFound,
    receiptScopeNote: observation.receiptScopeNote,
  }, null, 2)}\n`);
} else {
  for (const finding of observation.findings) {
    process.stdout.write(`${JSON.stringify({ kind: "finding", ...finding })}\n`);
  }
  for (const defect of observation.diskDefects) {
    process.stdout.write(`${JSON.stringify({ kind: "disk-defect", ...defect })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    kind: "summary",
    type: observation.type,
    root: observation.root,
    registry: observation.registry,
    packages: observation.findings.length,
    counts: observation.counts,
    diskDefects: observation.diskDefects.length,
    receiptFound: observation.receiptFound,
    receiptScopeNote: observation.receiptScopeNote,
  })}\n`);
}

const clean = observation.counts["stale-manifest"] === 0 && observation.counts.unpublished === 0 && observation.counts["source-missing"] === 0;
process.exit(values.strict && !clean ? 1 : 0);
