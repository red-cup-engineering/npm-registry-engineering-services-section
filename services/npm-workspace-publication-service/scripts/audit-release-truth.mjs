#!/usr/bin/env node
import { scanAllManifestSites, classifyPublishedPackage } from "../src/release-truth.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

if (args.includes("--help")) {
  process.stderr.write(
    "usage: audit-release-truth [--root <dir>] [--registry <url>]\n" +
    "Classifies every published package against on-disk sources: live-match,\n" +
    "version-mismatch, legacy-only, or no-disk-match. Exits 1 if any package's\n" +
    "resolved (latest) version is legacy-only — that package's default install\n" +
    "silently serves retired content as current.\n",
  );
  process.exit(0);
}

const root = opt("--root", process.cwd());
const registry = opt("--registry", "http://127.0.0.1:4873/");
const base = registry.endsWith("/") ? registry : `${registry}/`;

const response = await fetch(`${base}-/verdaccio/data/packages`);
if (!response.ok) {
  process.stderr.write(`registry unreachable at ${base}: HTTP ${response.status}\n`);
  process.exit(2);
}
const published = await response.json();

const byName = await scanAllManifestSites(root);
const classifications = published.map((pkg) => classifyPublishedPackage(pkg, byName.get(pkg.name)));

const byCategory = { "live-match": [], "version-mismatch": [], "legacy-only": [], "no-disk-match": [] };
for (const c of classifications) byCategory[c.category].push(c);

process.stdout.write(`${published.length} published packages checked against on-disk sources under ${root}\n\n`);
for (const [category, entries] of Object.entries(byCategory)) {
  process.stdout.write(`${category}: ${entries.length}\n`);
}

const masquerading = byCategory["legacy-only"];
if (masquerading.length > 0) {
  process.stdout.write(
    `\nlegacy-only packages — published, resolvable by default install, but every on-disk source\n` +
    `is under a legacy path. Nothing currently considers itself the live version of these:\n\n`,
  );
  for (const entry of masquerading) {
    process.stdout.write(`  ${entry.name}@${entry.version}\n`);
    for (const site of entry.sites) process.stdout.write(`    <- ${site.path}\n`);
  }
}

process.exit(masquerading.length > 0 ? 1 : 0);
