#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadConfiguredNpmRegistryTarball, publishConfiguredNpmRegistryArtifact, readConfiguredNpmRegistryPackageVersion } from "../src/registry.mjs";

// Source receiving and publication are separate: this command reads the exact
// identity and compares its advertised digests with the one packed artifact.
const mode = process.argv[2];
if (!["before", "after", "publish"].includes(mode)) throw new Error("expected before, after or publish");
const { PACKAGE: name, VERSION: version, PACKAGE_ARCHIVE: archive, REGISTRY: address } = process.env;
if (!name || !version || !archive || !address) throw new Error("exact package, version, archive and registry authority required");
const registry = new URL(address);
if (registry.protocol !== "https:" || registry.username || registry.password || registry.search || registry.hash) throw new Error("registry requires credential-free HTTPS addressing");
const bytes = await readFile(archive);
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const shasum = createHash("sha1").update(bytes).digest("hex");
let result = await readConfiguredNpmRegistryPackageVersion(registry.href, name, version);
if (result.authorizationFailed) throw new Error("registry receiving refused: authentication or authorization failed");
if (!result.reachable) throw new Error("registry metadata is unread; absence is not established");
if (!result.found && mode === "publish") {
  await publishConfiguredNpmRegistryArtifact({ registry: registry.href, name, version, artifact: archive });
  result = await readConfiguredNpmRegistryPackageVersion(registry.href, name, version);
  if (!result.reachable || result.authorizationFailed) throw new Error("published registry metadata is unread");
}
if (!result.found && mode === "before") {
  console.log(JSON.stringify({ state: "absent", name, version, integrity }));
} else {
  if (!result.found) throw new Error("published artifact is absent after publication");
  const published = result.manifest;
  if (published.name !== name || published.version !== version) throw new Error("registry returned another package or version");
  const digests = new Set((published.dist?.integrity ?? "").split(/\s+/));
  if (!(digests.has(integrity) || (!published.dist?.integrity && published.dist?.shasum === shasum))) throw new Error("published version differs from the packed source; preserve it and qualify a new declared version");
  const receiving = await mkdtemp(join(tmpdir(), "npm-artifact-receiving-"));
  try {
    await downloadConfiguredNpmRegistryTarball({ registry: registry.href, name, version, integrity, destination: join(receiving, "package.tgz"), npmEnvironment: { npm_config_cache: join(receiving, "cache") } });
    console.log(JSON.stringify({ state: "received", name, version, integrity, artifactDownloaded: true, source: process.env.GITHUB_SHA }));
  } finally { await rm(receiving, { recursive: true, force: true }); }
}
