#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pinExactDependencies } from "../src/pin-exact-dependencies.mjs";
import { scanRepositoryManifests } from "../src/read-workspace-manifests.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : undefined;
};
const optAll = (name) => args.flatMap((value, index) => (value === name && args[index + 1] !== undefined ? [args[index + 1]] : []));

const packageDirs = optAll("--package");
const rootArg = opt("--root");
const apply = args.includes("--apply");

if (packageDirs.length === 0 && rootArg === undefined) {
  process.stderr.write("usage: pin-exact-dependencies (--package <dir>)... | --root <repoRoot> [--plan|--apply]\n");
  process.exit(2);
}

const sites = [];
for (const dir of packageDirs) {
  const absoluteDir = resolve(dir);
  const path = join(absoluteDir, "package.json");
  sites.push({ path, dir: absoluteDir, manifest: JSON.parse(await readFile(path, "utf8")) });
}
if (rootArg !== undefined) {
  const root = resolve(rootArg);
  for (const site of await scanRepositoryManifests(root)) {
    if (site.manifest !== null) sites.push(site);
  }
}

const report = await pinExactDependencies({ sites, apply });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
