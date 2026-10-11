#!/usr/bin/env node
// Route every estate scope to the local Verdaccio registry, machine-wide.
//
// Why this exists: npm resolves per-project config from the nearest
// package.json directory only, so the repo root's .npmrc never reaches
// the estate's hundreds of nested packages. Before this script, every
// session rediscovered that as a 404 on some @red-cup-engineering
// install and patched one directory's .npmrc by hand. User-level
// config (~/.npmrc) applies to every npm invocation regardless of
// working directory, which makes it the one durable place for scope
// routing. Public packages keep resolving against npmjs directly, so
// nothing depends on Verdaccio being up except estate-scope installs,
// which depend on it anyway.
//
// The scope list is derived from Verdaccio's own config.yaml packages
// section — the registry's config is the source of truth, so adding a
// scope there and rerunning this script is the entire onboarding path
// for a new scope. Idempotent: existing correct lines are left alone,
// missing ones appended, conflicting ones (same scope, different
// registry) rewritten, and local routes absent from the registry
// configuration removed. Run with --check to report without writing (exit 1
// if changes would be made).

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Canonical registry (registry.561.group on cold-red-gate). The local
// verdaccio, when present, is only a read-through cache of it — client
// routing always targets the canonical so lockfiles resolve everywhere.
const REGISTRY = "https://registry.561.group/";
const here = dirname(fileURLToPath(import.meta.url));
const configArgumentIndex = process.argv.indexOf("--config");
if (configArgumentIndex >= 0 && !process.argv[configArgumentIndex + 1]) {
  console.error("--config requires a path");
  process.exit(2);
}
const configPath = configArgumentIndex >= 0
  ? resolve(process.cwd(), process.argv[configArgumentIndex + 1])
  : join(here, "..", "content", "config", "config.yaml");
const npmrcPath = join(homedir(), ".npmrc");
const checkOnly = process.argv.includes("--check");

const scopes = [
  ...readFileSync(configPath, "utf8").matchAll(/^\s{2}'(@[^/']+)\/\*'/gm),
].map((m) => m[1]);
if (scopes.length === 0) {
  console.error(`no scopes found in ${configPath} — refusing to proceed`);
  process.exit(2);
}

let npmrc = "";
try {
  npmrc = readFileSync(npmrcPath, "utf8");
} catch {
  // no user npmrc yet; we create one
}

const lines = npmrc.split("\n");
const wanted = new Map(scopes.map((s) => [s, `${s}:registry=${REGISTRY}`]));
const report = { ok: [], added: [], rewritten: [], removed: [] };

for (let i = 0; i < lines.length; i++) {
  const match = lines[i].match(/^(@[^:]+):registry=(.+)$/);
  if (!match) continue;
  if (!wanted.has(match[1])) {
    if (match[2].trim() === REGISTRY) {
      report.removed.push(match[1]);
      lines.splice(i, 1);
      i--;
    }
    continue;
  }
  if (match[2].trim() === REGISTRY) {
    report.ok.push(match[1]);
  } else {
    report.rewritten.push(`${match[1]} (was ${match[2].trim()})`);
    lines[i] = wanted.get(match[1]);
  }
  wanted.delete(match[1]);
}
for (const [scope, line] of wanted) {
  report.added.push(scope);
  lines.push(line);
}

const changed =
  report.added.length + report.rewritten.length + report.removed.length > 0;
for (const [label, items] of Object.entries(report)) {
  if (items.length) console.log(`${label}: ${items.join(", ")}`);
}

if (!changed) {
  console.log(`~/.npmrc already routes all ${scopes.length} estate scopes`);
  process.exit(0);
}
if (checkOnly) {
  console.log("--check: changes needed, nothing written");
  process.exit(1);
}
const output = lines.join("\n").replace(/\n*$/, "\n");
writeFileSync(npmrcPath, output, { mode: 0o600 });
console.log(
  `wrote ${npmrcPath}: ${scopes.length} scopes now route to ${REGISTRY}`,
);
