#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readConfiguredNpmRegistryPackageVersion } from "../src/registry.mjs";

// Source receiving and publication are separate: this command reads the exact
// identity and compares its advertised digests with the one packed artifact.
const mode = process.argv[2];
if (!["before", "after"].includes(mode)) throw new Error("expected before or after publication");
const { PACKAGE: name, VERSION: version, PACKAGE_ARCHIVE: archive, REGISTRY: address } = process.env;
if (!name || !version || !archive || !address) throw new Error("exact package, version, archive and registry authority required");
const registry = new URL(address);
if (registry.protocol !== "https:" || registry.username || registry.password || registry.search || registry.hash) throw new Error("registry requires credential-free HTTPS addressing");
const bytes = await readFile(archive);
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const shasum = createHash("sha1").update(bytes).digest("hex");
const result = await readConfiguredNpmRegistryPackageVersion(registry.href, name, version);
if (result.authorizationFailed) throw new Error("registry receiving refused: authentication or authorization failed");
if (!result.reachable) throw new Error("registry metadata is unread; absence is not established");
if (!result.found && mode === "before") {
  console.log(JSON.stringify({ state: "absent", name, version, integrity }));
} else {
  if (!result.found) throw new Error("published artifact is absent after publication");
  const published = result.manifest;
  if (published.name !== name || published.version !== version) throw new Error("registry returned another package or version");
  const digests = new Set((published.dist?.integrity ?? "").split(/\s+/));
  if (!(digests.has(integrity) || (!published.dist?.integrity && published.dist?.shasum === shasum))) throw new Error("published version differs from the packed source; preserve it and qualify a new declared version");
  console.log(JSON.stringify({ state: "received", name, version, integrity, source: process.env.GITHUB_SHA }));
}
