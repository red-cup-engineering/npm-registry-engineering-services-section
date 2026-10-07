#!/usr/bin/env node
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { inspectInstalledNpmPackage } from "@red-cup-engineering/inspect-installed-npm-package-service";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { parseJavascriptArgv } from "@red-cup-engineering/javascript-node-services-section/argv";
import { readJavascriptFileExportDocumentation } from "@red-cup-engineering/read-javascript-file-export-documentation-service";
import { selectNpmRegistryPackages } from "@red-cup-engineering/npm-registry-services-section/select-npm-registry-packages";

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

function registryUrl(candidate) {
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href;
  } catch { throw new TypeError("registry receipt must carry an HTTP or HTTPS registry URL"); }
}

async function installAndInspect(row, context) {
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
      const installation = await context.execute("npm", ["install", "--prefix", projectRoot, "--registry", context.registry, "--ignore-scripts", "--workspaces=false", "--include-workspace-root=false", "--no-package-lock", "--save-exact", "--no-audit", "--no-fund", `${row.name}@${row.version}`], { env: environment, signal: context.signal, maxBuffer: 16 * 1024 * 1024 });
      if (installation.error || installation.signal || (installation.status !== undefined && installation.status !== 0)) throw Object.assign(new Error(installation.error?.message ?? installation.stderr ?? "npm installation failed"), { code: installation.error?.code, spawnError: installation.error?.message ?? null });
    } catch (error) {
      return freezeJson({ type: "NpmRegistryPackageInstallationCheckRead", version: 1, name: row.name, packageVersion: row.version, installed: false, inspection: null, defects: [{ law: "registry-package-installation", diagnostic: error.stderr || error.stdout || error.message, code: error.code ?? null, spawnError: error.spawnError ?? null }] });
    }
    const packageRoot = join(projectRoot, "node_modules", ...row.name.split("/"));
    try {
      const inspection = await inspectInstalledNpmPackage({ type: "InstalledNpmPackageInspectionRequest", version: 1, packageRoot, expectedName: row.name, expectedVersion: row.version, projectRoot });
      return freezeJson({ type: "NpmRegistryPackageInstallationCheckRead", version: 1, name: row.name, packageVersion: row.version, installed: true, inspection, defects: inspection.defects });
    } catch (error) {
      return freezeJson({ type: "NpmRegistryPackageInstallationCheckRead", version: 1, name: row.name, packageVersion: row.version, installed: true, inspection: null, defects: [{ law: "installed-package-inspection", diagnostic: error.message, code: error.code ?? null }] });
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
  return freezeJson({ type: "NpmRegistryPackageInstallationsCheckReceipt", version: 1, registry, selection, concurrency: request.concurrency, reads, conformant: defects.length === 0, defects });
}

if (import.meta.main) {
  const parsed = parseJavascriptArgv({ type: "JavascriptArgvParsingRequest", version: 1, argumentVector: { type: "JavascriptArgumentVector", version: 1, arguments: process.argv }, options: { help: { type: "boolean", short: "h", default: false } }, allowPositionals: false, strict: true });
  if (parsed.options.help) {
    const source = await readFile(new URL(import.meta.url), "utf8");
    const [documentation] = readJavascriptFileExportDocumentation({ type: "TextFileRead", path: "scripts/check-npm-registry-package-installations.mjs", text: source });
    const helpOutput = `${documentation.name} — ${documentation.description}\n\n${documentation.signature}\n`;
    if (!process.stdout.write(helpOutput)) await once(process.stdout, "drain");
  } else {
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
