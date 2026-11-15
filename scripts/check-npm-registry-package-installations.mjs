#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { freezeJson } from "@red-cup-engineering/json-engine/freeze-json";
import { inspectInstalledNpmPackage } from "@red-cup-engineering/inspect-installed-npm-package-service";
import { parseArgs } from "node:util";
import { selectNpmRegistryPackages } from "@red-cup-engineering/npm-registry-engineering-services-section/select-npm-registry-packages";

const executeNpm = promisify(execFile);

function exactRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) throw new TypeError("input must be an NpmRegistryPackageInstallationsCheckRequest");
  if (Object.keys(request).sort().join(",") !== "concurrency,npmConfigPath,registryReceiptPath,selections,type,version") throw new TypeError("request must carry exactly concurrency, npmConfigPath, registryReceiptPath, selections, type, and version");
  if (request.type !== "NpmRegistryPackageInstallationsCheckRequest" || request.version !== 1) throw new TypeError("request type and version must be NpmRegistryPackageInstallationsCheckRequest@1");
  for (const field of ["npmConfigPath", "registryReceiptPath"]) if (typeof request[field] !== "string" || !isAbsolute(request[field]) || resolve(request[field]) !== request[field]) throw new TypeError(`${field} must be an absolute normalized path`);
  if (!Array.isArray(request.selections) || !request.selections.every((selection) => typeof selection === "string" && selection.length > 0)) throw new TypeError("selections must be an array of strings");
  if (!Number.isInteger(request.concurrency) || request.concurrency < 1 || request.concurrency > 32) throw new TypeError("concurrency must be an integer from 1 through 32");
  return request;
}

/** Parse receipt evidence without ever treating embedded credentials or URL parameters as authority. */
function receiptHttpAddress(candidate) {
  if (typeof candidate !== "string" || /[\u0000-\u0020\u007f?#]/u.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function registryUrl(candidate) {
  const url = receiptHttpAddress(candidate);
  if (!url) throw new TypeError("registry receipt must carry a credential-free HTTP or HTTPS registry URL without parameters");
  return url.href;
}

function releaseHasArtifact(row) {
  const digest = row.integrity;
  if (typeof digest !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(digest)
      || Buffer.from(digest.slice(7), "base64").toString("base64") !== digest.slice(7)) return false;
  const tarball = receiptHttpAddress(row.tarball);
  return tarball !== null && tarball.href === row.tarball;
}

async function inspectInstallLock(projectRoot, row) {
  const defect = field => ({ law: "registry-installed-artifact", field });
  let lock, bytes;
  try {
    bytes = await readFile(join(projectRoot, "package-lock.json"));
    lock = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError) && error?.code !== "ENOENT") throw error;
    return { binding: null, defects: [defect("package-lock")] };
  }
  const item = lock?.packages?.["node_modules/" + row.name];
  if (![2, 3].includes(lock?.lockfileVersion) || !item || typeof item !== "object" || Array.isArray(item))
    return { binding: null, defects: [defect("package-lock")] };
  const defects = [];
  if (item.link === true) defects.push(defect("link"));
  if (item.version !== row.version) defects.push(defect("version"));
  if (item.integrity !== row.integrity) defects.push(defect("integrity"));
  if (item.resolved !== row.tarball) defects.push(defect("resolved"));
  return { binding: defects.length ? null : {
    lockfileVersion: lock.lockfileVersion,
    lockfileSha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: row.integrity,
    tarball: row.tarball,
  }, defects };
}

async function installAndInspect(row, context) {
  if (!releaseHasArtifact(row))
    return freezeJson({ type: "NpmRegistryPackageInstallationCheckRead", version: 1, name: row.name, packageVersion: row.version,
      installed: false, inspection: null, artifactBinding: null,
      defects: [{ law: "registry-release-artifact", diagnostic: "Receipt must identify an exact tarball and canonical SHA-512 integrity" }] });
  const projectRoot = await mkdtemp(join(context.temporaryParent, "npm-registry-installation-check-"));
  try {
    await writeFile(join(projectRoot, "package.json"), '{"private":true}\n');
    const environment = {
      ...process.env,
      NPM_CONFIG_USERCONFIG: context.npmConfigPath,
      NPM_CONFIG_CACHE: join(projectRoot, ".npm-cache"),
      NPM_CONFIG_PREFER_ONLINE: "true",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      NPM_CONFIG_WORKSPACES: "false",
    };
    try {
      const installation = await context.execute("npm", ["install", "--prefix", projectRoot, "--registry", context.registry, "--ignore-scripts", "--workspaces=false", "--include-workspace-root=false", "--package-lock=true", "--save-exact", "--no-audit", "--no-fund", `${row.name}@${row.version}`], { env: environment, signal: context.signal, maxBuffer: 16 * 1024 * 1024 });
      if (installation.error || installation.signal || (installation.status !== undefined && installation.status !== 0)) throw Object.assign(new Error(installation.error?.message ?? installation.stderr ?? "npm installation failed"), { code: installation.error?.code, spawnError: installation.error?.message ?? null });
    } catch (error) {
      return freezeJson({ type: "NpmRegistryPackageInstallationCheckRead", version: 1, name: row.name, packageVersion: row.version, installed: false, inspection: null, artifactBinding: null, defects: [{ law: "registry-package-installation", diagnostic: error.stderr || error.stdout || error.message, code: error.code ?? null, spawnError: error.spawnError ?? null }] });
    }
    const packageRoot = join(projectRoot, "node_modules", ...row.name.split("/"));
    let lock;
    try { lock = await inspectInstallLock(projectRoot, row); }
    catch { lock = { binding: null, defects: [{ law: "registry-installed-artifact", field: "package-lock" }] }; }
    try {
      const inspection = await inspectInstalledNpmPackage({ type: "InstalledNpmPackageInspectionRequest", version: 1, packageRoot, expectedName: row.name, expectedVersion: row.version, projectRoot });
      return freezeJson({ type: "NpmRegistryPackageInstallationCheckRead", version: 1, name: row.name, packageVersion: row.version, installed: true, inspection, artifactBinding: lock.binding, defects: [...lock.defects, ...inspection.defects] });
    } catch (error) {
      return freezeJson({ type: "NpmRegistryPackageInstallationCheckRead", version: 1, name: row.name, packageVersion: row.version, installed: true, inspection: null, artifactBinding: lock.binding, defects: [...lock.defects, { law: "installed-package-inspection", diagnostic: error.message, code: error.code ?? null }] });
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

/**
 * Checks selected exact releases from one npm registry receipt by clean installation and installed-package inspection.
 *
 * @param {object} request An NpmRegistryPackageInstallationsCheckRequest@1 naming a receipt, npm configuration, selectors, and bounded concurrency.
 * @param {object} capabilities Optional assay capabilities; production callers omit this argument.
 * @returns {Promise<object>} An immutable NpmRegistryPackageInstallationsCheckReceipt@1 containing every installation read and defect.
 */
export async function checkNpmRegistryPackageInstallations(request, capabilities = {}) {
  exactRequest(request);
  const receipt = JSON.parse(await readFile(request.registryReceiptPath, "utf8"));
  if (!Array.isArray(receipt.packages)) throw new TypeError("registry receipt must carry a packages array");
  const registry = registryUrl(receipt.registry);
  const selection = selectNpmRegistryPackages({ type: "NpmRegistryPackageSelectionRequest", version: 1, packages: receipt.packages, selections: request.selections });
  const context = { registry, npmConfigPath: request.npmConfigPath, temporaryParent: capabilities.temporaryParent ?? tmpdir(), execute: capabilities.execute ?? executeNpm, signal: capabilities.signal };
  const reads = new Array(selection.packages.length);
  let next = 0;
  async function work() {
    while (next < selection.packages.length) {
      const index = next++;
      reads[index] = await installAndInspect(selection.packages[index], context);
    }
  }
  await Promise.all(Array.from({ length: Math.min(request.concurrency, selection.packages.length) }, () => work()));
  const defects = reads.flatMap((read) => read.defects.map((defect) => ({ name: read.name, packageVersion: read.packageVersion, ...defect })));
  if (reads.length === 0)
    defects.push({ law: "registry-installation-selection", diagnostic: "No exact registry releases were selected for installation" });
  return freezeJson({ type: "NpmRegistryPackageInstallationsCheckReceipt", version: 1, registry, selection, concurrency: request.concurrency, reads, conformant: defects.length === 0, defects });
}

if (import.meta.main) {
  const parsed = parseArgs({ args: process.argv.slice(2), options: { help: { type: "boolean", short: "h", default: false } }, allowPositionals: false, strict: true });
  if (parsed.values.help) {
    const {readJavascriptFileExportDocumentation} = await import("@red-cup-engineering/read-javascript-file-export-documentation-service");
    const source = await readFile(new URL(import.meta.url), "utf8");
    const [documentation] = readJavascriptFileExportDocumentation({ type: "TextFileRead", path: "scripts/check-npm-registry-package-installations.mjs", text: source });
    const helpOutput = `${documentation.name} — ${documentation.description}\n\n${documentation.signature}\n`;
    if (!process.stdout.write(helpOutput)) await once(process.stdout, "drain");
  } else {
    const {parseLines, serializeLines} = await import("@red-cup-engineering/jsonl-engineering-services-section");
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const receipts = [];
    for (const request of parseLines(text)) receipts.push(await checkNpmRegistryPackageInstallations(request));
    if (receipts.some((receipt) => !receipt.conformant)) process.exitCode = 1;
    const output = serializeLines(receipts);
    if (!process.stdout.write(output)) await once(process.stdout, "drain");
  }
}
