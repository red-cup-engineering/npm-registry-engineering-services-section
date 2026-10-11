#!/usr/bin/env node
/**
 * Keep the registry's store to what only it can serve. A private name (the configuration's `privateScopes` and
 * `privateNames`) is held only here and is never touched. A public name is the uplink's: its packument is
 * refreshed from registry.npmjs.org whenever it is requested and older than `uplinkMaxAgeMs`, so a public name no
 * request has touched for `--unused-days` is a cache entry nothing uses, and goes. With `cachePublicTarballs`
 * false, a public tarball left from before that setting is never needed (installations keep their own verified
 * bytes) and goes too.
 *
 *   prune-uplink-cache.mjs --configuration <registry.json, ~ allowed> [--unused-days 7] [--dry-run]
 */
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { configuration: { type: "string" }, "unused-days": { type: "string", default: "7" }, "dry-run": { type: "boolean" } } });
const home = homedir(), expand = (p) => (p.startsWith("/") ? p : join(home, p.replace(/^~\/?/u, "")));
if (!values.configuration) throw new Error("usage: prune-uplink-cache.mjs --configuration <registry.json> [--unused-days 7] [--dry-run]");
const configuration = JSON.parse(readFileSync(expand(values.configuration), "utf8"));
const storage = expand(configuration.storage), privateScopes = configuration.privateScopes ?? [], privateNames = configuration.privateNames ?? [];
const isPrivate = (name) => privateNames.includes(name) || privateScopes.some((scope) => name.startsWith(`${scope}/`));
const unusedMs = Number(values["unused-days"]) * 86400000, now = Date.now();

const names = [];
for (const entry of readdirSync(storage, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (entry.name.startsWith("@")) { for (const inner of readdirSync(join(storage, entry.name), { withFileTypes: true })) if (inner.isDirectory()) names.push(`${entry.name}/${inner.name}`); }
  else names.push(entry.name);
}
const report = { kind: "registry-uplink-prune.v1", storage, dryRun: Boolean(values["dry-run"]), unusedDays: Number(values["unused-days"]), publicNames: 0, removedNames: 0, removedTarballs: 0, freedBytes: 0 };
for (const name of names) {
  if (isPrivate(name)) continue;
  report.publicNames += 1;
  const dir = join(storage, name), files = readdirSync(dir).map((f) => ({ f, s: statSync(join(dir, f)) }));
  const bytes = files.reduce((n, x) => n + x.s.size, 0), newest = Math.max(0, ...files.map((x) => x.s.mtimeMs));
  if (now - newest > unusedMs) {
    if (!values["dry-run"]) rmSync(dir, { recursive: true, force: true });
    report.removedNames += 1; report.freedBytes += bytes; continue;
  }
  if (configuration.cachePublicTarballs === false) for (const x of files) if (x.f.endsWith(".tgz")) {
    if (!values["dry-run"]) rmSync(join(dir, x.f), { force: true });
    report.removedTarballs += 1; report.freedBytes += x.s.size;
  }
}
for (const entry of readdirSync(storage, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith("@") && !values["dry-run"]) { try { if (!readdirSync(join(storage, entry.name)).length) rmSync(join(storage, entry.name), { recursive: true }); } catch {} }
process.stdout.write(`${JSON.stringify(report)}\n`);
