#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
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
const sourceReceiving = await receiveSourceBytes();
let result = await readConfiguredNpmRegistryPackageVersion(registry.href, name, version);
if (result.authorizationFailed) throw new Error("registry receiving refused: authentication or authorization failed");
if (!result.reachable) throw new Error("registry metadata is unread; absence is not established");
if (!result.found && mode === "publish") {
  await publishConfiguredNpmRegistryArtifact({ registry: registry.href, name, version, artifact: archive });
  result = await readConfiguredNpmRegistryPackageVersion(registry.href, name, version);
  if (!result.reachable || result.authorizationFailed) throw new Error("published registry metadata is unread");
}
if (!result.found && mode === "before") {
  console.log(JSON.stringify({ state: "absent", name, version, integrity, sourceReceiving }));
} else {
  if (!result.found) throw new Error("published artifact is absent after publication");
  const published = result.manifest;
  if (published.name !== name || published.version !== version) throw new Error("registry returned another package or version");
  const digests = new Set((published.dist?.integrity ?? "").split(/\s+/));
  if (!(digests.has(integrity) || (!published.dist?.integrity && published.dist?.shasum === shasum))) throw new Error("published version differs from the packed source; preserve it and qualify a new declared version");
  const receiving = await mkdtemp(join(tmpdir(), "npm-artifact-receiving-"));
  try {
    await downloadConfiguredNpmRegistryTarball({ registry: registry.href, name, version, integrity, destination: join(receiving, "package.tgz"), npmEnvironment: { npm_config_cache: join(receiving, "cache") } });
    console.log(JSON.stringify({ state: "received", name, version, integrity, artifactDownloaded: true, source: process.env.GITHUB_SHA, sourceReceiving }));
  } finally { await rm(receiving, { recursive: true, force: true }); }
}

/** Receive raw source packages against their explicit immutable Git owner.
 * Compiled products need their own generation receiving; omission of this
 * selection leaves source bytes unobserved rather than treating a label as proof. */
async function receiveSourceBytes() {
  const { SOURCE_GIT_DIR: directory, SOURCE_REVISION: revision, SOURCE_PACKAGE_PATH: prefix } = process.env;
  if ([directory, revision, prefix].every(value => value === undefined)) return { state: "unobserved" };
  if (!directory || !isAbsolute(directory) || !/^[a-f0-9]{40}$/u.test(revision ?? "") || typeof prefix !== "string" || (prefix !== "" && (isAbsolute(prefix) || prefix.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\"))))) throw new TypeError("source receiving requires an absolute Git directory, exact commit and canonical package path (empty for repository root)");
  const run = promisify(execFileCallback);
  const git = (...arguments_) => run("git", ["--no-replace-objects", "--git-dir", directory, ...arguments_], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  const selected = String((await git("rev-parse", "--verify", `${revision}^{commit}`)).stdout).trim();
  if (selected !== revision) throw new Error("source selection differs from the exact commit");
  const { stdout } = await run("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const paths = new Set();
  for (const entry of stdout.split("\n").filter(path => path && !path.endsWith("/"))) {
    const path = entry.slice("package/".length);
    if (!entry.startsWith("package/") || path.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\")) || paths.has(path)) throw new Error("artifact requires unique canonical package file paths");
    paths.add(path);
    const packed = (await run("tar", ["-xOf", archive, entry], { encoding: null, maxBuffer: 64 * 1024 * 1024 })).stdout;
    const authored = (await git("show", `${revision}:${prefix ? prefix + "/" : ""}${path}`)).stdout;
    if (!packed.equals(authored)) throw new Error(`artifact differs from selected source: ${path}`);
  }
  if (!paths.has("package.json")) throw new Error("artifact requires its selected package manifest");
  if (!(await readFile(archive)).equals(bytes)) throw new Error("artifact changed during source receiving");
  return { state: "received", revision, packagePath: prefix, files: paths.size };
}
