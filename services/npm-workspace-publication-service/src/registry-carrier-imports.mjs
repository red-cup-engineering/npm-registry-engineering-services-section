import vm from "node:vm";
import { builtinModules } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { packageExportSurfacePaths } from "./carrier-surface.mjs";
const run = promisify(execFile);
const rootName = name => name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];

function target(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(target).find(Boolean);
  if (value && typeof value === "object") return target(value.import ?? value.node ?? value.default);
  return null;
}
export function registryExportTarget(manifest, specifier) {
  const key = specifier === manifest.name ? "." : `.${specifier.slice(manifest.name.length)}`;
  if (manifest.exports === undefined) return manifest.main && key === "." ? manifest.main : key === "." ? "./index.js" : `.${specifier.slice(manifest.name.length)}`;
  if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) return key === "." ? target(manifest.exports) : null;
  if (Object.keys(manifest.exports).every(key => !key.startsWith("."))) return key === "." ? target(manifest.exports) : null;
  if (Object.hasOwn(manifest.exports, key)) return target(manifest.exports[key]);
  for (const [pattern, value] of Object.entries(manifest.exports)) {
    if (!pattern.includes("*")) continue;
    const [before, after] = pattern.split("*");
    if (key.startsWith(before) && key.endsWith(after)) return target(value)?.replaceAll("*", key.slice(before.length, after.length ? -after.length : undefined));
  }
  return null;
}

/** Inspect static ESM links without executing any application. Only reachable
 * public modules are followed; browser assets and unrelated package scripts
 * are not treated as Node entrances. Computed dynamic links remain a separately
 * stated receiving obligation, rather than a guessed closed graph. */
export async function auditRegistryCarrierImports({ packed, existing = [], directory, onProgress = () => {} }) {
  if (typeof vm.SourceTextModule !== "function") throw new Error("static ESM inspection requires --experimental-vm-modules");
  const manifests = new Map(existing.filter(e => e.found).map(e => [`${e.name}@${e.version}`, e]));
  const artifacts = new Map(packed.packages.map(e => [`${e.name}@${e.version}`, e]));
  for (const entry of packed.packages) {
    const { stdout } = await run("tar", ["-xOf", entry.artifact, "package/package.json"], { maxBuffer: 1024 * 1024 });
    manifests.set(`${entry.name}@${entry.version}`, JSON.parse(stdout));
  }
  const receipt = { kind: "npm.registry-carrier-static-imports", packages: [], findings: [] };
  for (const entry of packed.packages) {
    const manifest = manifests.get(`${entry.name}@${entry.version}`), files = new Set(entry.files), seen = new Set();
    const pending = packageExportSurfacePaths(manifest).filter(path => /\.(mjs|js)$/u.test(path));
    const carrier = await mkdtemp(join(directory, ".imports-"));
    try {
      await run("tar", ["-xzf", entry.artifact, "-C", carrier, "--strip-components=1"], { maxBuffer: 1024 * 1024 });
      while (pending.length) {
        const file = pending.pop();
        if (seen.has(file) || !/\.(mjs|js)$/u.test(file)) continue;
        seen.add(file);
        if (!files.has(file)) { receipt.findings.push({ name: entry.name, file, kind: "missing-local-module" }); continue; }
        if (file.endsWith(".js") && manifest.type !== "module") continue;
        const text = await readFile(join(carrier, file), "utf8");
        let requests;
        try { requests = new vm.SourceTextModule(text, { identifier: file }).dependencySpecifiers; }
        catch (error) { receipt.findings.push({ name: entry.name, file, kind: "invalid-es-module", message: error.message }); continue; }
        for (const specifier of requests) {
          if (specifier.startsWith("node:") || builtinModules.includes(specifier) || /^https?:/u.test(specifier)) continue;
          if (specifier.startsWith(".")) {
            const local = posix.normalize(posix.join(posix.dirname(file), specifier));
            if (local.startsWith("../") || !files.has(local)) receipt.findings.push({ name: entry.name, file, specifier, kind: "missing-local-module" });
            else pending.push(local);
            continue;
          }
          if (specifier.startsWith("#")) continue;
          const dependency = rootName(specifier), version = manifest.dependencies?.[dependency] ?? manifest.optionalDependencies?.[dependency] ?? manifest.peerDependencies?.[dependency];
          if (dependency !== manifest.name && !version) { receipt.findings.push({ name: entry.name, file, specifier, kind: "undeclared-runtime-dependency" }); continue; }
          const supplier = dependency === manifest.name ? manifest : manifests.get(`${dependency}@${version}`);
          if (!supplier) continue; // Third-party internals are received by their registry installation.
          const resolved = registryExportTarget(supplier, specifier);
          if (!resolved) receipt.findings.push({ name: entry.name, file, specifier, version, kind: "unpublished-export-subpath" });
          else if (dependency === manifest.name) pending.push(resolved.replace(/^\.\//u, ""));
          else {
            const artifact = artifacts.get(`${dependency}@${version}`);
            if (artifact && !artifact.files.includes(resolved.replace(/^\.\//u, ""))) receipt.findings.push({ name: entry.name, file, specifier, version, kind: "missing-provider-target" });
          }
        }
      }
    } finally { await rm(carrier, { recursive: true, force: true }); }
    receipt.packages.push({ name: entry.name, modules: seen.size });
    await onProgress(receipt, entry.name);
  }
  return receipt;
}
