import { posix } from "node:path";

function normalizePackedPath(value) {
  return typeof value === "string" ? value.replace(/^package\//u, "").replace(/^\.\//u, "") : null;
}

function declaredTargetPath(target, field) {
  if (typeof target !== "string" || target.length === 0) return null;
  const stripped = field === "exports" ? target.replace(/^\.\//u, "") : normalizePackedPath(target);
  if (field === "exports" && !target.startsWith("./")) return null;
  if (stripped === null || stripped === "" || posix.isAbsolute(stripped) || stripped.split("/").includes("..") || stripped.includes("\\")) return null;
  return stripped;
}

function exportTargets(value, field = "exports") {
  if (typeof value === "string") return [{ field, target: value }];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => exportTargets(entry, `${field}[${index}]`));
  return Object.entries(value).flatMap(([key, entry]) => exportTargets(entry, `${field}.${key}`));
}

function wildcardPattern(target) {
  const pieces = target.split("*").map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (pieces.length === 1) return null;
  let expression = `^${pieces[0]}(.+)`;
  for (let index = 1; index < pieces.length; index += 1) {
    expression += index === 1 ? pieces[index] : `\\1${pieces[index]}`;
  }
  return new RegExp(`${expression}$`, "u");
}

function surfaceDeclarations(manifest) {
  const declarations = [];
  const rootExport = typeof manifest?.exports === "string"
    || Array.isArray(manifest?.exports)
    || (manifest?.exports !== null && typeof manifest?.exports === "object"
      && (Object.hasOwn(manifest.exports, ".") || Object.keys(manifest.exports).every((key) => !key.startsWith("."))));
  if (!rootExport && manifest?.main !== undefined) declarations.push({ field: "main", target: manifest.main });
  declarations.push(...exportTargets(manifest?.exports));
  if (typeof manifest?.bin === "string") declarations.push({ field: "bin", target: manifest.bin });
  else if (manifest?.bin !== null && typeof manifest?.bin === "object" && !Array.isArray(manifest.bin)) {
    for (const [name, target] of Object.entries(manifest.bin)) declarations.push({ field: `bin.${name}`, target });
  }
  return declarations;
}

/**
 * List the concrete (non-wildcard) file paths a manifest's `exports` map (every
 * condition, not just the first import/node/default hit), `bin` entries, and
 * `main` fallback promise to a consumer — the package's actual export surface.
 * A file the tarball ships outside this surface (a stray build artifact, a
 * dropped internal module) is never reachable through the manifest's own
 * public contract, so its removal cannot break a consumer that only imports
 * declared subpaths.
 * @param {object} manifest A parsed package.json document.
 * @returns {readonly string[]} Normalized reachable file paths, deduplicated and sorted.
 */
export function packageExportSurfacePaths(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return Object.freeze([]);
  const paths = new Set();
  for (const declaration of surfaceDeclarations(manifest)) {
    const kind = declaration.field.startsWith("bin") ? "bin" : declaration.field === "main" ? "main" : "export";
    const target = declaredTargetPath(declaration.target, kind === "export" ? "exports" : kind);
    if (target === null || wildcardPattern(target) !== null) continue;
    paths.add(target);
  }
  return Object.freeze([...paths].sort());
}

/**
 * Compare an npm manifest's executable/import promises with the final files npm
 * measured for its tarball. This deliberately accepts the post-lifecycle packlist:
 * generated entrypoints are promises about the carrier, not the source checkout.
 */
export function carrierSurfaceViolations(manifest, packedPaths) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError("manifest must be an object");
  if (!packedPaths || typeof packedPaths[Symbol.iterator] !== "function") throw new TypeError("packedPaths must be iterable");
  const carried = new Set([...packedPaths].map(normalizePackedPath).filter((path) => path !== null));
  const violations = [];
  for (const declaration of surfaceDeclarations(manifest)) {
    const kind = declaration.field.startsWith("bin") ? "bin" : declaration.field === "main" ? "main" : "export";
    const target = declaredTargetPath(declaration.target, kind === "export" ? "exports" : kind);
    if (target === null) {
      violations.push(Object.freeze({ kind: "invalid-carrier-target", field: declaration.field, target: declaration.target ?? null }));
      continue;
    }
    const pattern = wildcardPattern(target);
    if (pattern === null ? !carried.has(target) : ![...carried].some((path) => pattern.test(path))) {
      violations.push(Object.freeze({
        kind: pattern === null ? "missing-carrier-target" : "unmatched-carrier-pattern",
        field: declaration.field,
        target: declaration.target,
      }));
    }
  }
  return Object.freeze(violations);
}
