import { readFile, access, readdir, writeFile, mkdir, glob, cp, mkdtemp, rm } from "node:fs/promises";
import { resolve, dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { carrierSurfaceViolations } from "./carrier-surface.mjs";
import { SECRET_PATH, secretBearingContentPaths } from "./tarball-guard.mjs";
import { readRegistryPackage, readRegistryPackageVersion, publishConfiguredNpmRegistryArtifact, downloadConfiguredNpmRegistryTarball } from "./registry.mjs";
import { packageExportSurfacePaths } from "./carrier-surface.mjs";
import { dependencySpecificationViolations } from "./dependency-policy.mjs";

const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const local = /^(workspace:|file:|link:)/u;
const stable = /^(\d+)\.(\d+)\.(\d+)$/u;
const run = promisify(execFile);
const compare = (a, b) => { const aa = a.split(".").map(Number), bb = b.split(".").map(Number); return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2]; };

/** Plan one explicit source selection, never discover a workspace or resolve
 * executable suppliers from source. Locators are authoring custody only.
 * Every changed provider gets a new, unoccupied immutable release identity;
 * this preserves its assessed source API instead of guessing that latest is
 * compatible. Publication remains a separate packed-artifact operation. */
export async function planSourceRegistryClosure({ consumerPaths, providers, registry = "https://registry.561.group/", readRegistry = readRegistryPackage, concurrency = 6 }) {
  if (!Array.isArray(consumerPaths) || !consumerPaths.length || !Array.isArray(providers)) throw new TypeError("explicit consumers and provider locators required");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new TypeError("concurrency must be 1 through 12");
  const sources = new Map(), aliases = new Map(), byPath = new Map();
  for (const entry of [...providers, ...consumerPaths.map(path => ({ path }))]) {
    const path = resolve(entry.path.endsWith("package.json") ? entry.path : join(entry.path, "package.json"));
    let manifest;
    try { manifest = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const previous = sources.get(manifest.name);
    if (previous && previous.path !== path && !consumerPaths.includes(path)) throw new Error(`duplicate provider identity: ${manifest.name}`);
    const source = { path, dir: dirname(path), manifest };
    sources.set(manifest.name, source); byPath.set(path, source);
    if (entry.name && entry.name !== manifest.name) aliases.set(entry.name, manifest.name);
  }
  const selected = new Map(), required = new Set(), absent = new Set();
  const visit = (name) => {
    name = aliases.get(name) ?? name;
    if (selected.has(name)) return;
    const source = sources.get(name);
    if (!source) { absent.add(name); return; }
    selected.set(name, source);
    for (const field of fields) for (const [dependency, specification] of Object.entries(source.manifest[field] ?? {})) {
      if (!local.test(specification)) continue;
      const canonical = aliases.get(dependency) ?? dependency;
      required.add(canonical); visit(canonical);
    }
  };
  for (const path of consumerPaths) {
    const source = byPath.get(resolve(path));
    if (!source) throw new Error(`consumer source not received: ${path}`);
    visit(source.manifest.name);
  }
  if (absent.size) return { kind: "npm.source-registry-closure", complete: false, missingProviders: [...absent].sort(), missingEdges: [...selected].flatMap(([name, source]) => fields.flatMap(field => Object.keys(source.manifest[field] ?? {}).filter(dependency => absent.has(dependency)).map(dependency => ({ consumer: name, path: source.path, field, dependency })))), packages: [] };
  const metadata = new Map(), names = [...selected.keys()];
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      if (!required.has(name)) continue;
      const result = await readRegistry(registry, name);
      if (!result.reachable) throw new Error(`registry metadata unread: ${name}`);
      metadata.set(name, result);
    }
  }));
  const releases = new Map();
  for (const name of required) {
    const source = selected.get(name), result = metadata.get(name);
    const occupied = new Set(Object.keys(result.packument?.versions ?? {}));
    const development = /^(0)\.(\d+)\.\d+-/u.exec(source.manifest.version);
    // A changed development line is not an admitted stable promotion. Start
    // the next 0.x minor line instead of silently downgrading to registry latest.
    const sourceVersion = development ? `0.${Number(development[2]) + 1}.0` : source.manifest.version;
    const candidates = [...occupied, sourceVersion].filter(v => stable.test(v) && Number(v.split(".")[0]) === 0).sort(compare);
    let version = candidates.at(-1) ?? "0.1.0";
    if (occupied.has(version)) { const coordinates = version.split(".").map(Number); coordinates[2]++; version = coordinates.join("."); }
    releases.set(name, version);
  }
  const packages = [];
  for (const [name, source] of selected) {
    const manifest = structuredClone(source.manifest), rewrites = [];
    if (required.has(name)) { manifest.version = releases.get(name); manifest.private = false; }
    for (const field of fields) for (const [dependency, specification] of Object.entries(manifest[field] ?? {})) {
      const canonical = aliases.get(dependency) ?? dependency, version = releases.get(canonical);
      if (!local.test(specification) && version === undefined) continue;
      if (!version) throw new Error(`unplanned provider: ${dependency}`);
      delete manifest[field][dependency]; manifest[field][canonical] = version;
      rewrites.push({ field, name: dependency, canonical, from: specification, to: version });
    }
    delete manifest.workspaces; delete manifest.overrides;
    const missingTargets = [];
    for (const target of packageExportSurfacePaths(manifest)) {
      try { await access(join(source.dir, target)); } catch { missingTargets.push(target); }
    }
    packages.push({ name, path: source.path, publish: required.has(name), from: source.manifest.version, manifest, rewrites, missingTargets, violations: dependencySpecificationViolations(manifest) });
  }
  return { kind: "npm.source-registry-closure", registry, complete: true, consumers: consumerPaths.length, aliases: Object.fromEntries(aliases), packages };
}

const digest = text => createHash("sha256").update(text).digest("hex");

/** Bind a selected carrier to its received authoring bytes and constrain npm's
 * default recursive packlist. An enclosing section never acquires a nested
 * package merely because its source happens to be mounted beneath it. */
export async function prepareSourceRegistryCarriers(plan, { providers = [] } = {}) {
  if (!plan.complete) throw new Error("unresolved source selection");
  const boundaries = [...new Set([...providers.map(p => resolve(p.path.endsWith("package.json") ? dirname(p.path) : p.path)), ...plan.packages.map(p => dirname(p.path))])];
  for (const entry of plan.packages) {
    const dir = dirname(entry.path), text = await readFile(entry.path, "utf8");
    const source = JSON.parse(text);
    if (source.name !== entry.name || source.version !== entry.from) throw new Error(`source identity advanced: ${entry.path}`);
    for (const rewrite of entry.rewrites) if (source[rewrite.field]?.[rewrite.name] !== rewrite.from) throw new Error(`source edge advanced: ${entry.name} ${rewrite.name}`);
    entry.sourceDigest = digest(text);
    if (!entry.publish) continue;
    const targets = packageExportSurfacePaths(entry.manifest);
    if (!entry.manifest.files) {
      const files = new Set(["package.json", "README*", "LICENSE*"]);
      for (const target of targets) files.add(target.startsWith("services/") ? dirname(target) : target.includes("/") ? target.split("/")[0] : target);
      for (const asset of ["src", "bin", "scripts", "apps", "content/config", "content/data", "content/schemas", "content/structured-data", "schemas", "conformance", "assets", "public", "web", "dist"]) {
        try { await access(join(dir, asset)); files.add(asset); } catch {}
      }
      entry.manifest.files = [...files];
    }
    entry.embeddedProviders = [];
    for (const child of boundaries) {
      const locator = relative(dir, child).split(sep).join("/");
      if (!locator || locator.startsWith("../") || locator === "..") continue;
      if (targets.some(target => target.startsWith(`${locator}/`))) { entry.embeddedProviders.push(locator); continue; }
      if (!entry.manifest.files.some(pattern => {
        if (pattern.startsWith("!")) return false;
        const prefix = pattern.replace(/^\.\//u, "").split("*")[0].replace(/\/$/u, "");
        return prefix === "" || locator === prefix || locator.startsWith(`${prefix}/`);
      })) continue;
      if (!entry.manifest.files.includes(`!${locator}/**`)) entry.manifest.files.push(`!${locator}/**`);
    }
    entry.missingTargets = [];
    for (const target of targets) { try { await access(join(dir, target)); } catch { entry.missingTargets.push(target); } }
    entry.violations = dependencySpecificationViolations(entry.manifest);
  }
  return plan;
}

/** Apply only an entirely admitted selection, with optimistic source custody.
 * This writes declarations; publication and registry installation are separate. */
export async function applySourceRegistryClosure(plan) {
  if (!plan.complete) throw new Error("unresolved source selection");
  for (const entry of plan.packages) {
    if (entry.missingTargets.length || dependencySpecificationViolations(entry.manifest).length) throw new Error(`unfabricated carrier: ${entry.name}`);
    if (!entry.sourceDigest || digest(await readFile(entry.path, "utf8")) !== entry.sourceDigest) throw new Error(`source bytes advanced: ${entry.path}`);
  }
  const changed = [];
  for (const entry of plan.packages) {
    await writeFile(entry.path, `${JSON.stringify(entry.manifest, null, 2)}\n`);
    const npmrc = join(dirname(entry.path), ".npmrc");
    let text = "";
    try { text = await readFile(npmrc, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    text = text.replace(/^registry\s*=.*\r?\n?/gmu, "");
    await writeFile(npmrc, `registry=${plan.registry}\n${text}`);
    changed.push(entry.path, npmrc);
  }
  return { kind: "npm.source-registry-closure.applied", manifests: plan.packages.length, changed };
}

/** Port canonical package identities through explicitly selected package bodies.
 * Nested packages are independent owners and are visited only when selected. */
export async function rewriteSourceRegistryAliases(plan, { maxFilesPerPackage = 2000 } = {}) {
  const aliases = new Map(plan.packages.flatMap(entry => entry.rewrites.filter(r => r.name !== r.canonical).map(r => [r.name, r.canonical])));
  const changed = [];
  for (const entry of plan.packages) {
    const root = dirname(entry.path), pending = [root];
    let count = 0;
    while (pending.length) {
      const dir = pending.pop();
      for (const file of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, file.name);
        if (file.isDirectory()) {
          if (file.name.startsWith(".") || ["node_modules", "data", "services"].includes(file.name)) continue;
          try { await access(join(path, "package.json")); continue; } catch {}
          pending.push(path);
        } else if (file.isFile() && /\.(?:[cm]?js|[cm]?ts)$/u.test(file.name)) {
          if (++count > maxFilesPerPackage) throw new Error(`explicit source body bound exceeded: ${entry.name}`);
          const text = await readFile(path, "utf8");
          let next = text;
          for (const [from, to] of aliases) next = next.replaceAll(from, to);
          if (text !== next) { await writeFile(path, next); changed.push(path); }
        }
      }
    }
  }
  return { kind: "npm.source-registry-closure.identities", aliases: Object.fromEntries(aliases), changed };
}

/** Fabricate immutable artifacts without substituting local dependencies or
 * running package suites. Actual exported files and credential custody are
 * judged on npm's final packlist. Registry receiving follows separately. */
export async function packSourceRegistryClosure(plan, { destination, onProgress = () => {} } = {}) {
  if (!destination || !plan.complete) throw new TypeError("admitted plan and artifact destination required");
  await mkdir(destination, { recursive: true });
  const receipt = { kind: "npm.source-registry-closure.packed", registry: plan.registry, packages: [], refusals: [] };
  for (const entry of plan.packages.filter(entry => entry.publish)) {
    const dir = dirname(entry.path), manifest = JSON.parse(await readFile(entry.path, "utf8"));
    if (JSON.stringify(manifest) !== JSON.stringify(entry.manifest)) throw new Error(`source declaration advanced: ${entry.name}`);
    const staging = await mkdtemp(join(destination, ".carrier-"));
    const excludes = ["node_modules", "node_modules/**", "**/node_modules", "**/node_modules/**", ".git", ".git/**", ...manifest.files.filter(pattern => pattern.startsWith("!")).map(pattern => pattern.slice(1))];
    const selection = new Set(["package.json"]);
    for (const pattern of manifest.files.filter(pattern => !pattern.startsWith("!"))) {
      for await (const file of glob([pattern, `${pattern}/**/*`], { cwd: dir, withFileTypes: true, exclude: excludes })) {
        if (!file.isDirectory()) selection.add(relative(dir, join(file.parentPath, file.name)));
      }
    }
    for (const file of selection) {
      await mkdir(dirname(join(staging, file)), { recursive: true });
      await cp(join(dir, file), join(staging, file), { preserveTimestamps: true, verbatimSymlinks: true });
    }
    let packed;
    try {
      const { stdout } = await run("npm", ["pack", "--ignore-scripts", "--workspaces=false", "--json", "--pack-destination", destination], { cwd: staging, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
      [packed] = JSON.parse(stdout);
    } finally { await rm(staging, { recursive: true, force: true }); }
    // npm's JSON is log output and may redact apparent credentials in names.
    // Judge the actual archive, rather than treating that log as a file index.
    const listing = await run("tar", ["-tzf", join(destination, packed.filename), "--quoting-style=literal"], { maxBuffer: 32 * 1024 * 1024 });
    const files = listing.stdout.split("\n").filter(path => path && !path.endsWith("/")).map(path => path.replace(/^package\//u, ""));
    const surface = carrierSurfaceViolations(manifest, files);
    const carrier = await mkdtemp(join(destination, ".packed-"));
    let secrets;
    try {
      await run("tar", ["-xzf", join(destination, packed.filename), "-C", carrier, "--strip-components=1"], { maxBuffer: 1024 * 1024 });
      secrets = await secretBearingContentPaths(carrier, files);
    } finally { await rm(carrier, { recursive: true, force: true }); }
    if (surface.length || secrets.length || files.some(path => SECRET_PATH.test(path))) {
      receipt.refusals.push({ name: entry.name, surface, credentialContent: secrets.length > 0, credentialPath: files.some(path => SECRET_PATH.test(path)) });
    }
    receipt.packages.push({ name: manifest.name, version: manifest.version, path: entry.path, artifact: join(destination, packed.filename), integrity: packed.integrity, size: packed.size, unpackedSize: packed.unpackedSize, files });
    await onProgress(receipt, entry.name);
  }
  return receipt;
}

/** Publish only the fixed artifacts, then independently fetch each exact
 * release through configured registry access and compare SHA512. A conflicting
 * occupied version is retained and refused; it is never overwritten. */
export async function publishSourceRegistryClosure(packed, { receivingDirectory, onProgress = () => {} } = {}) {
  if (packed.refusals.length || !receivingDirectory) throw new Error("fabricated, unrefused artifacts and receiving directory required");
  await mkdir(receivingDirectory, { recursive: true });
  const receipt = { kind: "npm.source-registry-closure.received", registry: packed.registry, packages: [] };
  for (const entry of packed.packages) {
    const actualIntegrity = `sha512-${createHash("sha512").update(await readFile(entry.artifact)).digest("base64")}`;
    if (actualIntegrity !== entry.integrity) throw new Error(`packed artifact changed: ${entry.name}`);
    let metadata = await readRegistryPackageVersion(packed.registry, entry.name, entry.version);
    if (!metadata.reachable) throw new Error(`registry unread: ${entry.name}`);
    if (!metadata.found) {
      await publishConfiguredNpmRegistryArtifact({ registry: packed.registry, name: entry.name, version: entry.version, artifact: entry.artifact });
      metadata = await readRegistryPackageVersion(packed.registry, entry.name, entry.version);
    }
    if (!metadata.found || !metadata.manifest.dist?.integrity?.split(/\s+/u).includes(entry.integrity)) throw new Error(`occupied release differs from selected artifact: ${entry.name}@${entry.version}`);
    const receiving = await mkdtemp(join(receivingDirectory, ".download-"));
    try {
      await downloadConfiguredNpmRegistryTarball({ registry: packed.registry, name: entry.name, version: entry.version, integrity: entry.integrity, destination: join(receiving, "release.tgz"), npmEnvironment: { npm_config_cache: join(receiving, "cache") } });
    } finally { await rm(receiving, { recursive: true, force: true }); }
    receipt.packages.push({ name: entry.name, version: entry.version, integrity: entry.integrity, artifactDownloaded: true });
    await onProgress(receipt, entry.name);
  }
  return receipt;
}

/** Resolve each consumer independently through its configured registry, then
 * receive a frozen installation. Fresh-release admission is limited to exact
 * identities whose actual registry bytes were independently downloaded. */
export async function receiveSourceRegistryConsumers({ consumerPaths, releases, logDirectory, onProgress = () => {} }) {
  if (!Array.isArray(consumerPaths) || !Array.isArray(releases) || !logDirectory) throw new TypeError("explicit consumers, received releases and log directory required");
  if (releases.some(release => release.artifactDownloaded !== true || !release.integrity?.startsWith("sha512-"))) throw new Error("release admission requires independent artifact receiving");
  await mkdir(logDirectory, { recursive: true });
  const admission = releases.map(release => `--config.minimumReleaseAgeExclude=${release.name}@${release.version}`);
  const receipt = { kind: "npm.source-registry-closure.consumers", packages: [], refusals: [] };
  for (const path of consumerPaths) {
    const manifestText = await readFile(path, "utf8"), manifest = JSON.parse(manifestText), dir = dirname(path);
    if (dependencySpecificationViolations(manifest).length) throw new Error(`consumer declarations are not exact: ${manifest.name}`);
    const log = join(logDirectory, `${manifest.name.replaceAll("/", "-").replace(/^@/u, "")}.log`);
    let output = "";
    try {
      for (const mode of ["resolve", "frozen"]) {
        const args = [...admission, "install", "--ignore-workspace", "--ignore-scripts", "--reporter=append-only", ...(mode === "resolve" ? ["--lockfile-only", "--no-frozen-lockfile"] : ["--frozen-lockfile"])];
        const result = await run("pnpm", args, { cwd: dir, env: { ...process.env, CI: "true" }, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
        output += `${mode}\n${result.stdout}${result.stderr}\n`;
      }
      const lock = await readFile(join(dir, "pnpm-lock.yaml"), "utf8");
      if (/(?:workspace:|\blink:|\bfile:)/u.test(lock)) throw new Error("received lock contains a local dependency binding");
      receipt.packages.push({ name: manifest.name, version: manifest.version, path, frozenInstall: true, manifestDigest: digest(manifestText), lockDigest: digest(lock), log });
    } catch (error) {
      output += `${error.stdout ?? ""}${error.stderr ?? ""}\n${error.message}\n`;
      receipt.refusals.push({ name: manifest.name, path, log, reason: error.code ?? error.message });
    }
    await writeFile(log, output);
    await onProgress(receipt, manifest.name);
  }
  return receipt;
}
