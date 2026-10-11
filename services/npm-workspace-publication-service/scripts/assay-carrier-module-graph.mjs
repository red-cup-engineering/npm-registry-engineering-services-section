#!/usr/bin/env node
import { builtinModules } from "node:module";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsnodeModuleRequests } from "@red-cup-engineering/javascript-node-services-section/syntax";
import { requiredArgument } from "@red-cup-engineering/javascript-node-services-section/argv";

const JAVASCRIPT = /\.(?:mjs|js|cjs)$/u;
const TERMINAL_MODULE = /\.(?:json|node|wasm)$/u;

function bareRoot(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
}

function targetStrings(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(targetStrings);
  return Object.values(value).flatMap(targetStrings);
}

function hasRootExport(exports) {
  return typeof exports === "string"
    || Array.isArray(exports)
    || (exports !== null && typeof exports === "object"
      && (Object.hasOwn(exports, ".") || Object.keys(exports).every((key) => !key.startsWith("."))));
}

function nodeScriptTarget(command) {
  if (typeof command !== "string" || /[;&|<>`]/u.test(command)) return null;
  const words = command.trim().split(/\s+/u);
  if (words.shift() !== "node") return null;
  while (words[0]?.startsWith("-")) words.shift();
  const target = words[0];
  return target && !target.startsWith("-") ? target : null;
}

async function allCarrierFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function matchMapping(mapping, key) {
  if (mapping === undefined) return [];
  if (typeof mapping === "string" || Array.isArray(mapping)) return key === "." ? targetStrings(mapping) : [];
  if (mapping === null || typeof mapping !== "object") return [];
  const keys = Object.keys(mapping);
  if (keys.every((candidate) => !candidate.startsWith(".")) && key === ".") return targetStrings(mapping);
  if (Object.hasOwn(mapping, key)) return targetStrings(mapping[key]);
  const matches = keys
    .filter((candidate) => candidate.includes("*"))
    .map((candidate) => {
      const expression = new RegExp(`^${candidate.split("*").map(escapeRegularExpression).join("(.+)")}$`, "u");
      const found = expression.exec(key);
      return found ? { candidate, substitution: found[1] } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.candidate.length - left.candidate.length);
  if (matches.length === 0) return [];
  return targetStrings(mapping[matches[0].candidate]).map((target) => target.replaceAll("*", matches[0].substitution));
}

function surfaceTargets(manifest) {
  const targets = [];
  if (!hasRootExport(manifest.exports) && typeof manifest.main === "string") targets.push(manifest.main);
  targets.push(...targetStrings(manifest.exports));
  if (typeof manifest.bin === "string") targets.push(manifest.bin);
  else if (manifest.bin !== null && typeof manifest.bin === "object" && !Array.isArray(manifest.bin)) targets.push(...Object.values(manifest.bin));
  for (const command of Object.values(manifest.scripts ?? {})) {
    const target = nodeScriptTarget(command);
    if (target !== null) targets.push(target.startsWith(".") ? target : `./${target}`);
  }
  return targets;
}

function contained(root, path) {
  const local = relative(root, path);
  return local === "" || (!local.startsWith("..") && !isAbsolute(local));
}

async function fileEvidence(root, path) {
  if (!contained(root, path)) return { available: false, reason: "outside-carrier" };
  try {
    const [canonical, status] = await Promise.all([realpath(path), stat(path)]);
    if (!contained(root, canonical)) return { available: false, reason: "symlink-outside-carrier" };
    if (!status.isFile()) return { available: false, reason: "not-a-file" };
    return { available: true, canonical };
  } catch (error) {
    return { available: false, reason: error?.code === "ENOENT" ? "absent" : "unreadable" };
  }
}

async function resolveLocalRequest(root, importer, specifier, commonJs) {
  let requested;
  try {
    requested = specifier.startsWith("file:") ? fileURLToPath(specifier) : resolve(importer, "..", specifier);
  } catch { return { available: false, reason: "invalid-file-url" }; }
  const candidates = commonJs
    ? [requested, `${requested}.js`, `${requested}.json`, `${requested}.node`, resolve(requested, "index.js"), resolve(requested, "index.json"), resolve(requested, "index.node")]
    : [requested];
  for (const candidate of candidates) {
    const evidence = await fileEvidence(root, candidate);
    if (evidence.available) return evidence;
    if (evidence.reason === "outside-carrier" || evidence.reason === "symlink-outside-carrier") return evidence;
  }
  return { available: false, reason: "absent" };
}

function externalAllowedSets(manifest) {
  const runtime = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  const development = new Set(Object.keys(manifest.devDependencies ?? {}).filter((name) => !runtime.has(name)));
  return { runtime, development, all: new Set([...runtime, ...development]) };
}

export async function assayCarrierModuleGraph({ root, manifest }) {
  const carrierRoot = await realpath(resolve(root));
  const files = await allCarrierFiles(carrierRoot);
  const javascript = files.filter((path) => JAVASCRIPT.test(path));
  const allowed = externalAllowedSets(manifest);
  const graph = new Map();
  const violations = [];

  async function resolvePackageTarget(importer, request, target) {
    if (!target.startsWith("./")) return resolveSpecifier(importer, { ...request, specifier: target });
    const evidence = await fileEvidence(carrierRoot, resolve(carrierRoot, target));
    if (!evidence.available) violations.push({ kind: "unavailable-carrier-module", importer: relative(carrierRoot, importer), specifier: target, reason: evidence.reason });
    return evidence.available ? evidence.canonical : null;
  }

  async function resolveSpecifier(importer, request) {
    const { kind, specifier } = request;
    if (specifier === null) {
      return { computed: true };
    }
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("file:")) {
      const evidence = await resolveLocalRequest(carrierRoot, importer, specifier, kind === "commonjs-require");
      if (!evidence.available) violations.push({ kind: "unavailable-carrier-module", importer: relative(carrierRoot, importer), specifier, reason: evidence.reason });
      return evidence.available ? evidence.canonical : null;
    }
    if (specifier.startsWith("#")) {
      const targets = matchMapping(manifest.imports, specifier);
      if (targets.length === 0) {
        violations.push({ kind: "unmapped-package-import", importer: relative(carrierRoot, importer), specifier });
        return null;
      }
      const local = [];
      for (const target of targets) {
        const resolved = await resolvePackageTarget(importer, request, target);
        if (resolved !== null) local.push(resolved);
      }
      return local;
    }
    const dependency = bareRoot(specifier);
    if (specifier.startsWith("node:") || builtinModules.includes(specifier) || builtinModules.includes(dependency)) return null;
    if (dependency === manifest.name) {
      const subpath = specifier === manifest.name ? "." : `.${specifier.slice(manifest.name.length)}`;
      const targets = matchMapping(manifest.exports, subpath);
      if (targets.length === 0) {
        violations.push({ kind: "unexported-self-reference", importer: relative(carrierRoot, importer), specifier });
        return null;
      }
      const local = [];
      for (const target of targets) {
        const resolved = await resolvePackageTarget(importer, request, target);
        if (resolved !== null) local.push(resolved);
      }
      return local;
    }
    if (!allowed.all.has(dependency)) violations.push({ kind: "undeclared-carrier-dependency", importer: relative(carrierRoot, importer), specifier, dependency });
    return { external: dependency };
  }

  for (const path of javascript) {
    let requests;
    try {
      requests = readJsnodeModuleRequests(await readFile(path, "utf8"), path);
    } catch (error) {
      violations.push({ kind: "unparseable-carrier-module", importer: relative(carrierRoot, path), specifier: null, reason: String(error?.message ?? error) });
      continue;
    }
    const edges = [];
    for (const request of requests) {
      const resolved = await resolveSpecifier(path, request);
      for (const target of Array.isArray(resolved) ? resolved : [resolved]) if (target !== null) edges.push({ ...request, target });
    }
    graph.set(path, edges);
  }

  const runtimeQueue = [];
  for (const target of surfaceTargets(manifest)) {
    if (typeof target !== "string" || !target.startsWith("./")) continue;
    if (target.includes("*")) {
      const expression = new RegExp(`^${target.slice(2).split("*").map(escapeRegularExpression).join(".*")}$`, "u");
      runtimeQueue.push(...files.filter((path) => expression.test(relative(carrierRoot, path).replaceAll("\\", "/"))));
    } else {
      const evidence = await fileEvidence(carrierRoot, resolve(carrierRoot, target));
      if (evidence.available) runtimeQueue.push(evidence.canonical);
    }
  }
  const runtimeVisited = new Set();
  while (runtimeQueue.length > 0) {
    const path = runtimeQueue.shift();
    if (runtimeVisited.has(path) || TERMINAL_MODULE.test(path)) continue;
    runtimeVisited.add(path);
    for (const edge of graph.get(path) ?? []) {
      if (typeof edge.target === "string") runtimeQueue.push(edge.target);
      else if (edge.target.computed) violations.push({
        kind: "computed-runtime-module-request",
        importer: relative(carrierRoot, path),
        specifier: null,
        requestKind: edge.kind,
      });
      else if (allowed.development.has(edge.target.external)) violations.push({
        kind: "dev-only-runtime-dependency",
        importer: relative(carrierRoot, path),
        specifier: edge.specifier,
        dependency: edge.target.external,
      });
    }
  }

  return Object.freeze({
    outcome: violations.length === 0 ? "carrier-module-graph-admitted" : "carrier-module-graph-refused",
    packedJavaScriptModules: javascript.length,
    runtimeReachableModules: runtimeVisited.size,
    violations: Object.freeze(violations.map(Object.freeze)),
    analysisLimits: Object.freeze({ unparsedPackageScripts: Object.freeze(Object.entries(manifest.scripts ?? {}).filter(([, command]) => nodeScriptTarget(command) === null).map(([name]) => name)) }),
  });
}

async function main(args) {
  const root = resolve(requiredArgument("--root", args));
  const manifestPath = resolve(requiredArgument("--manifest", args));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = await assayCarrierModuleGraph({ root, manifest });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ outcome: "carrier-module-graph-refused", violations: [{ kind: "assay-failure", reason: String(error?.message ?? error) }] })}\n`);
    process.exitCode = 1;
  });
}
