import { setImmediate } from "node:timers";
import { posix } from "node:path";
import { lineColumnOf, parseJavaScript, walkJavaScript } from "@red-cup-engineering/javascript-parser-service";
import semver from "semver";
import { binTargets, exportTargets, resolveExport } from "./package-exports.mjs";
import { readTarball, TarballError } from "./tarball-reader.mjs";

/**
 * The publish gate: what a registry can say about a package version from its bytes and its own shelf, without
 * running any of it. A version is refused when what it ships does not hold together:
 *
 *   - `export-target`   an `exports` target (any condition Node resolves) that is not in the tarball, or a pattern
 *                       target no file of the tarball matches
 *   - `bin-target`      a `bin` target that is not in the tarball
 *   - `undeclared-import`  a JS module imports a house-scoped package that is neither this package nor declared in
 *                       dependencies, peerDependencies or optionalDependencies. Explicit receiving-only
 *                       modules may also use their declared devDependencies, with the same supplier checks.
 *   - `receiving-test`  a declared receiving root is absent or its declaration is not a file-path array
 *   - `self-import`     a JS module imports this package by name through an `exports` entry that does not exist
 *   - `dependency`      a declared house dependency whose version or range no published version satisfies
 *   - `dependency-subpath`  an import of `<house package>/<subpath>` that the highest published version satisfying
 *                       the declared range does not export (exports patterns and "./package.json" included)
 *   - `source`          a house-scoped module that the house parser cannot read
 *   - `tarball`         the tarball or its package.json cannot be read, or names another package or version
 *
 * Imports of other packages and node: builtins are not supplier-assayed; local edges distinguish runtime
 * modules from receiving-only modules without changing relative-target availability checks.
 */

export const DEFAULT_HOUSE_SCOPES = Object.freeze(["@red-cup-engineering", "@lenticule-science", "@561-group", "@coesite-operations", "@causeway-services", "@emsenn"]);

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SCRIPT_EXTENSIONS = /\.(?:mjs|cjs|js)$/u;
const escapesAt = /\\(?:u0040|u\{0*40\}|x40)/iu;

/** A specifier as { name, subpath } when it names a package of a house scope, else null. */
export function houseSpecifier(specifier, houseScopes) {
  const match = /^(@[^/]+)\/([^/]+)(\/.*)?$/u.exec(specifier);
  if (!match || !houseScopes.includes(match[1])) return null;
  return { name: `${match[1]}/${match[2]}`, subpath: match[3] === undefined ? "." : `.${match[3]}` };
}

/** Literal module edges. CommonJS edges also keep public runtime reachability out of receiving-only context. */
function moduleSpecifiers(source, { module }) {
  const program = parseJavaScript(source, { sourceType: module ? "module" : "script" });
  const found = [];
  walkJavaScript(program, (node) => {
    const commonJs = node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require" && node.arguments.length === 1;
    let specifier = commonJs ? node.arguments[0] : node.source;
    if (!commonJs && node.type !== "ImportDeclaration" && node.type !== "ExportAllDeclaration" && node.type !== "ExportNamedDeclaration" && node.type !== "ImportExpression") return;
    if (specifier?.type === "TemplateLiteral" && (node.type === "ImportExpression" || commonJs) && specifier.expressions.length === 0) specifier = { type: "Literal", value: specifier.quasis[0].value.cooked };
    if (specifier?.type === "Literal" && typeof specifier.value === "string") found.push({ specifier: specifier.value, at: lineColumnOf(source, node.start).line, commonJs });
  });
  return found;
}

function parseModule(path, source, packageIsModule) {
  const extension = path.slice(path.lastIndexOf("."));
  if (extension === ".mjs") return moduleSpecifiers(source, { module: true });
  if (extension === ".cjs") return moduleSpecifiers(source, { module: false });
  if (packageIsModule) return moduleSpecifiers(source, { module: true });
  // Node reads a .js file of an untyped package as CommonJS, and as an ES module when it cannot be CommonJS.
  try { return moduleSpecifiers(source, { module: false }); }
  catch (scriptError) {
    try { return moduleSpecifiers(source, { module: true }); }
    catch { throw scriptError; }
  }
}

const packageRelative = (target) => {
  if (typeof target !== "string") return null;
  const normal = posix.normalize(target);
  return normal === "." || normal.startsWith("../") || normal.startsWith("/") ? null : normal;
};
const patternOf = (target) => new RegExp(`^${target.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".+")}$`, "u");

/** The explicit receiving graph is a development consumer of the same archive.
 * A file also reachable from a public Node entry remains a runtime module.
 * This follows the literal module edges already read by the publication gate;
 * computed module requests retain the gate's existing interpretation.
 */
function receivingOnlyModules(manifest, files, modules, refuse) {
  if (manifest.receivingTests === undefined) return new Set();
  if (!Array.isArray(manifest.receivingTests)) {
    refuse("receiving-test", "receivingTests must name original files in this tarball");
    return new Set();
  }
  const roots = [];
  for (const target of manifest.receivingTests) {
    const path = packageRelative(target);
    if (path === null || !files.has(path)) refuse("receiving-test", `receivingTests -> ${JSON.stringify(target)} is not a file in the tarball`);
    else roots.push(path);
  }
  // Without exports every package subpath remains public to Node consumers.
  if (manifest.exports === undefined) return new Set();
  const expand = target => {
    const path = packageRelative(target);
    if (path === null) return [];
    return target.includes("*") ? [...files.keys()].filter(file => patternOf(path).test(file)) : files.has(path) ? [path] : [];
  };
  const publicRoots = exportTargets(manifest.exports).flatMap(entry => entry.alternatives ?? [entry.target]).flatMap(expand)
    .filter(path => SCRIPT_EXTENSIONS.test(path) || posix.extname(path) === "");
  publicRoots.push(...binTargets(manifest).flatMap(entry => expand(entry.target)));
  if (typeof manifest.main === "string") publicRoots.push(...expand(manifest.main));
  // Consumer lifecycle commands may run a development helper without exporting
  // it. Until their command graph is explicit, retain the ordinary runtime rule.
  if (["preinstall", "install", "postinstall", "start"].some(name => typeof manifest.scripts?.[name] === "string" && manifest.scripts[name].trim())) return new Set();
  const conditions = [["node", "import", "module-sync", "default"], ["node", "require", "module-sync", "default"]];
  const mappings = record(manifest.imports) ? Object.fromEntries(Object.entries(manifest.imports).map(([key, value]) => [`./${key.slice(1)}`, value])) : {};
  const targetsOf = (exports, subpath) => [...new Set(conditions.map(conditions => resolveExport(exports, subpath, conditions).target).filter(target => typeof target === "string"))];
  const local = (from, request) => {
    const { specifier, commonJs } = request;
    if (specifier.startsWith("#")) return targetsOf(mappings, `./${specifier.slice(1)}`).flatMap(expand);
    if (specifier === manifest.name || specifier.startsWith(manifest.name + "/")) {
      return targetsOf(manifest.exports, specifier === manifest.name ? "." : "." + specifier.slice(manifest.name.length)).flatMap(expand);
    }
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [];
    let path;
    try {
      const relative = commonJs ? specifier : decodeURIComponent(specifier.split(/[?#]/u)[0]);
      path = packageRelative(posix.join(posix.dirname(from), relative));
    } catch { return []; }
    if (path === null) return [];
    if (!commonJs) return files.has(path) ? [path] : [];
    const candidates = [path, ...[".js", ".json", ".node"].map(extension => path + extension),
      ...["index.js", "index.json", "index.node"].map(name => posix.join(path, name))];
    try {
      const nested = JSON.parse(files.get(posix.join(path, "package.json"))?.toString("utf8"));
      if (typeof nested?.main === "string") {
        const main = packageRelative(posix.join(path, nested.main));
        if (main !== null) candidates.push(main, main + ".js", main + ".json", posix.join(main, "index.js"));
      }
    } catch {}
    return candidates.filter(candidate => files.has(candidate));
  };
  const closure = starts => {
    const visited = new Set(), queue = [...starts];
    for (let at = 0; at < queue.length; at++) {
      const path = queue[at];
      if (visited.has(path)) continue;
      visited.add(path);
      for (const request of modules.get(path) ?? []) queue.push(...local(path, request));
    }
    return visited;
  };
  // Non-JavaScript public assets (including native Scheme constructors) are
  // present/export-assayed above, but are not JavaScript graph roots. Keep
  // every actual JS root and its reachable helpers in the runtime context.
  const runtime = closure(publicRoots);
  if ([...runtime].some(path => !modules.has(path) && !/\.(?:json|node)$/u.test(path))) return new Set();
  return new Set([...closure(roots)].filter(path => !runtime.has(path)));
}

/** The manifest of the highest published version of `entry.packument` satisfying `range`, or a reason there is none. */
const exactVersion = range => typeof range === "string" && semver.valid(range) === range;
function resolveVersion(packument, range) {
  if (exactVersion(range) && Object.hasOwn(packument.versions ?? {}, range))
    return { version: range, manifest: packument.versions[range] };
  const versions = Object.keys(packument.versions ?? {});
  let version;
  if (semver.validRange(range) !== null) version = semver.maxSatisfying(versions, range);
  else if (Object.hasOwn(packument["dist-tags"] ?? {}, range)) version = packument["dist-tags"][range];
  else return { reason: `${JSON.stringify(range)} is neither a semver range nor a dist-tag it publishes` };
  if (version === null || version === undefined || !Object.hasOwn(packument.versions ?? {}, version)) {
    const newest = versions.filter((v) => semver.valid(v)).sort(semver.rcompare).slice(0, 5);
    return { reason: `no published version satisfies ${JSON.stringify(range)} (newest published: ${newest.join(", ") || "none"})` };
  }
  return { version, manifest: packument.versions[version] };
}

const exportedKeys = (exports) => {
  if (!record(exports)) return exports === undefined ? [] : ["."];
  const keys = Object.keys(exports).filter((key) => key.startsWith("."));
  return keys.length > 0 ? keys : ["."];
};

/**
 * Check one version's tarball. `publishedPackument(name)` answers a package's full packument as this registry
 * would serve it (or null if it has none). Optional `publishedManifest(name, version)` reads one exact admitted
 * supplier; a missing exact read retains ordinary range/tag resolution. Histories are read only for fallback
 * or missing-export diagnostics. Returns violations: [{ kind, message }], empty when the version holds together.
 */
export async function checkPublication({ name, version, bytes, houseScopes = DEFAULT_HOUSE_SCOPES, publishedPackument, publishedManifest, maxUnpackedBytes }) {
  const violations = [];
  const refuse = (kind, message) => violations.push({ kind, message });
  let files;
  try { files = readTarball(bytes, maxUnpackedBytes === undefined ? undefined : { maxBytes: maxUnpackedBytes }); }
  catch (error) { if (error instanceof TarballError) return [{ kind: "tarball", message: error.message }]; throw error; }
  let manifest;
  try { manifest = JSON.parse(files.get("package.json")?.toString("utf8")); }
  catch { return [{ kind: "tarball", message: "the tarball has no readable package.json" }]; }
  if (!record(manifest)) return [{ kind: "tarball", message: "the tarball's package.json is not an object" }];
  if (manifest.name !== name || manifest.version !== version) {
    return [{ kind: "tarball", message: `the tarball's package.json is ${manifest.name}@${manifest.version}, not the ${name}@${version} being published` }];
  }

  // exports and bin targets
  const present = (target) => {
    const path = packageRelative(target);
    if (path === null) return false;
    return target.includes("*") ? [...files.keys()].some((file) => patternOf(path).test(file)) : files.has(path);
  };
  const unshipped = new Set();
  const shippedTarget = ({ where, target }, dotRequired) => {
    if (typeof target !== "string" || (dotRequired && !target.startsWith("./"))) refuse(dotRequired ? "export-target" : "bin-target", `${where} -> ${JSON.stringify(target)} is not a path inside the package${dotRequired ? ' (it must start with "./")' : ""}`);
    else if (!present(target)) { unshipped.add(target); refuse(dotRequired ? "export-target" : "bin-target", `${where} -> ${target} ${target.includes("*") ? "matches no file" : "is not"} in the tarball`); }
  };
  for (const entry of exportTargets(manifest.exports)) {
    if (entry.alternatives) {
      if (!entry.alternatives.some(present)) refuse("export-target", `${entry.where} -> none of ${entry.alternatives.join(", ")} is in the tarball`);
    } else shippedTarget(entry, true);
  }
  for (const entry of binTargets(manifest)) shippedTarget(entry, false);

  // declared house dependencies, keyed by the name a module imports them by
  const declared = new Map(), development = new Map();
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
    if (!record(manifest[field])) continue;
    const selection = field === "devDependencies" ? development : declared;
    for (const [key, spec] of Object.entries(manifest[field])) {
      if (typeof spec !== "string" || declared.has(key)) continue;
      const alias = /^npm:((?:@[^/]+\/)?[^@]+)(?:@(.*))?$/u.exec(spec);
      selection.set(key, alias ? { name: alias[1], range: alias[2] || "*", field, spec } : { name: key, range: spec, field, spec });
    }
  }
  const packuments = new Map();
  const manifests = new Map();
  const manifestOf = async (name, version) => {
    const key = `${name}@${version}`;
    if (!manifests.has(key)) manifests.set(key, Promise.resolve(publishedManifest(name, version)).then(manifest => {
      if (manifest === null || manifest === undefined) return null;
      if (!record(manifest) || manifest.name !== name || manifest.version !== version)
        throw new TypeError("selected supplier manifest differs from its exact requested identity");
      // Release unrelated selected-manifest content just as the history path does.
      return { exports: manifest.exports };
    }));
    return manifests.get(key);
  };
  const packumentOf = async (dependency) => {
    if (!packuments.has(dependency)) packuments.set(dependency, Promise.resolve(publishedPackument(dependency)).then(packument => {
      if (packument === null || packument === undefined) return packument;
      // Supplier selection and subpath diagnostics need versions, tags and
      // exports. Holding every historical manifest/README until this entire
      // publication finishes defeats the serving cache's retention budget.
      return { "dist-tags": packument["dist-tags"], versions: Object.fromEntries(
        Object.entries(packument.versions ?? {}).map(([version, manifest]) =>
          [version, record(manifest) ? { exports: manifest.exports } : manifest]),
      ) };
    }));
    return packuments.get(dependency);
  };
  const resolved = new Map(); // declared key -> { version, manifest } | { reason } | null (not house)
  const resolveDeclared = async (key, selection = declared) => {
    if (resolved.has(key)) return resolved.get(key);
    const entry = selection.get(key);
    let outcome = null;
    if (entry && houseSpecifier(`${entry.name}/x`, houseScopes)) {
      if (typeof publishedManifest === "function" && exactVersion(entry.range)) {
        const manifest = await manifestOf(entry.name, entry.range);
        if (manifest !== null) outcome = { version: entry.range, manifest };
      }
      if (outcome === null) {
        const packument = await packumentOf(entry.name);
        if (!packument) outcome = { reason: `${entry.name} is not published in this registry` };
        else outcome = { ...resolveVersion(packument, entry.range), packument };
      }
      if (outcome.reason) refuse("dependency", `${entry.field}["${key}"]: ${JSON.stringify(entry.spec)}: ${outcome.reason}`);
    }
    resolved.set(key, outcome);
    return outcome;
  };
  for (const key of declared.keys()) await resolveDeclared(key);

  // imports of house-scoped packages from the tarball's JS modules
  const prefixes = houseScopes.map((scope) => `${scope}/`);
  const modules = new Map();
  for (const [path, content] of files) {
    if (!SCRIPT_EXTENSIONS.test(path) || path.startsWith("node_modules/") || path.includes("/node_modules/")) continue;
    const source = content.toString("utf8");
    const namesHouse = prefixes.some((prefix) => source.includes(prefix)) || escapesAt.test(source);
    if (!namesHouse && manifest.receivingTests === undefined) continue;
    // Parsing is synchronous and a package can be large; let other requests through between modules.
    await new Promise((resolve) => setImmediate(resolve));
    let imports;
    try { imports = parseModule(path, source, manifest.type === "module"); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (namesHouse) refuse("source", `${path} names a house package but cannot be read as JavaScript: ${error.message}`);
      continue;
    }
    modules.set(path, imports);
  }
  const receivingOnly = receivingOnlyModules(manifest, files, modules, refuse);
  const reported = new Set();
  for (const [path, imports] of modules) {
    for (const { specifier, at, commonJs } of imports) {
      if (commonJs) continue; // Preserve the gate's existing house-import syntax contract.
      const target = houseSpecifier(specifier, houseScopes);
      if (!target) continue;
      const here = `${path}:${at} imports ${JSON.stringify(specifier)}`;
      const dedupe = `${path}\0${specifier}`;
      if (reported.has(dedupe)) continue;
      reported.add(dedupe);
      if (target.name === name) {
        const exported = resolveExport(manifest.exports, target.subpath);
        if (exported.legacy) refuse("self-import", `${here}, but ${name} declares no "exports", so it cannot be imported by its own name`);
        else if (exported.target === null) refuse("self-import", `${here}, but ${name} does not export ${JSON.stringify(target.subpath)} (its exports: ${exportedKeys(manifest.exports).join(", ")})`);
        else if (!files.has(packageRelative(exported.target) ?? "") && !unshipped.has(exported.target)) refuse("self-import", `${here}, which ${name} exports as ${exported.target}, but that file is not in the tarball`);
        continue;
      }
      const selection = declared.has(target.name) ? declared : receivingOnly.has(path) ? development : declared;
      if (!selection.has(target.name)) {
        refuse("undeclared-import", `${here}, but ${target.name} is not in dependencies, peerDependencies or optionalDependencies`);
        continue;
      }
      const dependency = await resolveDeclared(target.name, selection);
      if (!dependency?.manifest) continue; // already refused as unresolvable
      const exported = resolveExport(dependency.manifest.exports, target.subpath);
      if (exported.legacy || exported.target !== null) continue;
      const entry = selection.get(target.name);
      const packument = dependency.packument ?? await packumentOf(entry.name);
      const others = Object.entries(packument?.versions ?? {})
        .filter(([, other]) => resolveExport(other.exports, target.subpath).target)
        .map(([other]) => other).filter((other) => semver.valid(other)).sort(semver.rcompare).slice(0, 3);
      refuse("dependency-subpath", `${here}, but ${entry.name}@${dependency.version} (the highest published version satisfying ${JSON.stringify(entry.range)}) does not export ${JSON.stringify(target.subpath)}; it exports ${exportedKeys(dependency.manifest.exports).slice(0, 12).join(", ") || "nothing"}${exportedKeys(dependency.manifest.exports).length > 12 ? ", ..." : ""}${others.length > 0 ? `. Published versions that do export it: ${others.join(", ")}` : ""}`);
    }
  }
  return violations;
}
