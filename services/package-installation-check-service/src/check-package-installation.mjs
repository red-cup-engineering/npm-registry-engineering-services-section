import { execFile } from "node:child_process";
import { builtinModules } from "node:module";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const JAVASCRIPT = /\.(?:cjs|js|mjs)$/u;
const STATIC_SPECIFIER = /(?<!["'])(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\()\s*["'](\.{1,2}\/[^"']+)["']/gu;
const MODULE_SPECIFIER = /(?<!["'])(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\()\s*["']([^"']+)["']/gu;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const EXACT_RELEASE = /^(@[a-z0-9-]+\/[a-z0-9._-]+)@(\d+\.\d+\.\d+)$/u;

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function inside(root, candidate) {
  const displacement = relative(root, candidate);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`));
}

function faceTargets(manifest) {
  const targets = new Set();
  function collect(value) {
    if (typeof value === "string") targets.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  }
  collect(manifest.exports);
  collect(manifest.bin);
  collect(manifest.main);
  collect(manifest.module);
  collect(manifest.types);
  return [...targets].sort();
}

async function javascriptFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && JAVASCRIPT.test(entry.name)) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

async function resolvesRelativeImport(path) {
  for (const candidate of [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, `${path}.json`, join(path, "index.js"), join(path, "index.mjs"), join(path, "index.cjs")]) {
    if (await exists(candidate)) return true;
  }
  return false;
}

async function resolvedRelativeImport(path) {
  for (const candidate of [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, `${path}.json`, join(path, "index.js"), join(path, "index.mjs"), join(path, "index.cjs")]) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function dependencyName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
}

export async function inspectInstalledPackage({ packageRoot, expectedName, expectedVersion }) {
  const root = resolve(packageRoot);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const defects = [];
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) defects.push({ law: "installed-identity", expectedName, expectedVersion, actualName: manifest.name, actualVersion: manifest.version });
  for (const target of faceTargets(manifest)) {
    const absolute = resolve(root, target);
    if (!inside(root, absolute) || !(await exists(absolute))) defects.push({ law: "installed-face-target", target });
  }
  const files = await javascriptFiles(root);
  for (const file of files) {
    try { await execute(process.execPath, ["--check", file], { maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { defects.push({ law: "shipped-javascript-syntax", file: relative(root, file), diagnostic: error.stderr || error.message }); continue; }
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(STATIC_SPECIFIER)) {
      const target = resolve(dirname(file), match[1]);
      if (!inside(root, target)) defects.push({ law: "relative-import-membrane", file: relative(root, file), specifier: match[1] });
      else if (!(await resolvesRelativeImport(target))) defects.push({ law: "relative-import-target", file: relative(root, file), specifier: match[1] });
    }
  }
  const declaredDependencies = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }));
  const reachable = [];
  const queued = new Set();
  const runtimeSpecifiers = [];
  for (const target of faceTargets(manifest)) {
    if (target.includes("*")) continue;
    const absolute = await resolvedRelativeImport(resolve(root, target));
    if (absolute && JAVASCRIPT.test(absolute) && !queued.has(absolute)) { queued.add(absolute); reachable.push(absolute); }
  }
  for (let index = 0; index < reachable.length; index += 1) {
    const file = reachable[index];
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(MODULE_SPECIFIER)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const target = await resolvedRelativeImport(resolve(dirname(file), specifier));
        if (target && JAVASCRIPT.test(target) && !queued.has(target)) { queued.add(target); reachable.push(target); }
        continue;
      }
      if (BUILTINS.has(specifier) || specifier.startsWith("#")) continue;
      const dependency = dependencyName(specifier);
      if (dependency === manifest.name) continue;
      if (!declaredDependencies.has(dependency)) {
        defects.push({ law: "runtime-dependency-declaration", file: relative(root, file), specifier, dependency });
        continue;
      }
      runtimeSpecifiers.push({ file: relative(root, file), specifier });
    }
  }
  if (runtimeSpecifiers.length > 0) {
    const resolutionProgram = "const rows=JSON.parse(process.argv[1]);for(const row of rows){try{row.resolved=import.meta.resolve(row.specifier)}catch(error){row.diagnostic=error.message}}process.stdout.write(JSON.stringify(rows))";
    const checked = await execute(process.execPath, ["--input-type=module", "--eval", resolutionProgram, JSON.stringify(runtimeSpecifiers)], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    for (const row of JSON.parse(checked.stdout)) if (row.diagnostic) defects.push({ law: "runtime-dependency-resolution", file: row.file, specifier: row.specifier, diagnostic: row.diagnostic });
  }
  return Object.freeze({ name: manifest.name, version: manifest.version, javascriptFiles: files.length, reachableJavascriptFiles: reachable.length, defects });
}

export function selectRegistryPackages(packages, selections = []) {
  if (!Array.isArray(packages) || !Array.isArray(selections)) throw new TypeError("registry packages and selections must be arrays");
  if (selections.length === 0) return packages;
  const selected = [];
  for (const selection of [...new Set(selections)]) {
    const exact = selection.match(EXACT_RELEASE);
    const matches = exact
      ? packages.filter(({ name, version }) => name === exact[1] && version === exact[2])
      : packages.filter(({ name }) => name === selection);
    if (matches.length === 0) throw new Error(`package selection is absent from the registry receipt: ${selection}`);
    if (matches.length > 1) throw new Error(`package selection is version-ambiguous: ${selection}`);
    selected.push(matches[0]);
  }
  return selected;
}

async function installOne({ row, npmConfigPath, npmCommand, temporaryParent, signal }) {
  const territory = await mkdtemp(join(temporaryParent, "voxel-install-assay-"));
  try {
    const environment = { ...process.env, NPM_CONFIG_USERCONFIG: npmConfigPath, NPM_CONFIG_CACHE: join(territory, ".npm-cache"), NPM_CONFIG_PREFER_ONLINE: "true" };
    const installed = await execute(npmCommand, ["install", "--prefix", territory, "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund", `${row.name}@${row.version}`], { env: environment, signal, maxBuffer: 16 * 1024 * 1024 });
    let dependencyTree;
    try {
      const listed = await execute(npmCommand, ["ls", "--prefix", territory, "--all", "--json"], { env: environment, signal, maxBuffer: 64 * 1024 * 1024 });
      dependencyTree = JSON.parse(listed.stdout);
    } catch (error) {
      return { name: row.name, version: row.version, defects: [{ law: "complete-dependency-tree", diagnostic: error.stdout || error.stderr || error.message }] };
    }
    const [scope, leaf] = row.name.split("/");
    const inspection = await inspectInstalledPackage({ packageRoot: join(territory, "node_modules", scope, leaf), expectedName: row.name, expectedVersion: row.version });
    return { ...inspection, installedDependencyCount: Object.keys(dependencyTree.dependencies ?? {}).length, installOutput: installed.stdout.trim() };
  } catch (error) {
    return { name: row.name, version: row.version, defects: [{ law: "registry-name-install", diagnostic: error.stderr || error.stdout || error.message }] };
  } finally {
    await rm(territory, { recursive: true, force: true });
  }
}

async function procureComputeLease({ computeMarket, packageCount, concurrency }) {
  const maximumParallelism = concurrency ?? Math.min(availableParallelism(), 8);
  if (!Number.isInteger(maximumParallelism) || maximumParallelism < 1 || maximumParallelism > 32) throw new TypeError("concurrency must be an integer from 1 through 32");
  if (!computeMarket) return Object.freeze({
    provider: "urn:provider:local-node-process",
    parallelism: maximumParallelism,
    settlement: { type: "SelfSuppliedComputeCapacity", measuredAvailableParallelism: availableParallelism() },
  });
  if (typeof computeMarket.procure !== "function") throw new TypeError("computeMarket.procure must be a function");
  const lease = await computeMarket.procure(Object.freeze({
    type: "ComputeCapacityDemand",
    resource: "cpu-and-memory-process-slot",
    taskClass: "isolated-npm-package-installation-assay",
    workUnits: packageCount,
    maximumParallelism,
  }));
  if (!Number.isInteger(lease?.parallelism) || lease.parallelism < 1 || lease.parallelism > maximumParallelism) throw new Error("compute market returned an invalid parallelism lease");
  if (typeof lease.provider !== "string" || !lease.provider || !lease.settlement) throw new Error("compute market returned an unowned or unsettled lease");
  return lease;
}

export async function checkPackageInstallations({ registryReceiptPath, npmConfigPath, packageNames, concurrency, computeMarket, npmCommand = "npm", temporaryParent = tmpdir(), signal }) {
  if (!isAbsolute(registryReceiptPath) || !isAbsolute(npmConfigPath)) throw new TypeError("registryReceiptPath and npmConfigPath must be absolute");
  const receipt = JSON.parse(await readFile(registryReceiptPath, "utf8"));
  const selected = selectRegistryPackages(receipt.packages, packageNames);
  const computeLease = await procureComputeLease({ computeMarket, packageCount: selected.length, concurrency });
  const records = new Array(selected.length);
  let next = 0;
  async function work() {
    while (next < selected.length) {
      const index = next++;
      records[index] = await installOne({ row: selected[index], npmConfigPath, npmCommand, temporaryParent, signal });
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(computeLease.parallelism, selected.length) }, () => work())); }
  finally { if (typeof computeLease.release === "function") await computeLease.release(); }
  const defects = records.flatMap((record) => record.defects.map((defect) => ({ package: record.name, version: record.version, ...defect })));
  const result = Object.freeze({ type: "SemioticVoxelPackageInstallationAssayReceipt", version: 1, conformant: defects.length === 0, registry: receipt.registry, packages: records.length, compute: { provider: computeLease.provider, parallelism: computeLease.parallelism, settlement: computeLease.settlement }, records, defects });
  if (defects.length) throw Object.assign(new Error(`package installation assay refused: ${defects.length} defect(s)`), { receipt: result });
  return result;
}
