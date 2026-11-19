/**
 * A package manifest's `exports`, read the way Node reads it, over data alone. Nothing here touches a file
 * system: callers say which files exist.
 */

/** The conditions under which Node resolves an `import` of a package from Node's own ESM loader. */
export const IMPORT_CONDITIONS = Object.freeze(["node", "import", "module-sync", "default"]);
/** The conditions a published target can be reached by from Node: ESM, CommonJS and the shared fallback. */
const REACHABLE_CONDITIONS = new Set(["import", "require", "node", "module-sync", "default"]);

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `exports` as a map from subpath ("." or "./x") to target, or null when it is malformed (mixed keys). */
function subpathMap(exports) {
  if (exports === undefined) return undefined;
  if (!record(exports)) return { ".": exports };
  const keys = Object.keys(exports);
  const dotted = keys.filter((key) => key.startsWith("."));
  if (dotted.length === 0) return { ".": exports };
  return dotted.length === keys.length ? exports : null;
}

/** A target's string, resolved under `conditions`: a string, null (explicitly not exported), or undefined (nothing matched). */
function resolveTarget(target, conditions, substitution) {
  if (typeof target === "string") return substitution === undefined ? target : target.replaceAll("*", substitution);
  if (target === null) return null;
  if (Array.isArray(target)) {
    for (const item of target) {
      const resolved = resolveTarget(item, conditions, substitution);
      if (resolved !== undefined) return resolved;
    }
    return undefined;
  }
  if (record(target)) {
    for (const [condition, value] of Object.entries(target)) {
      if (condition !== "default" && !conditions.includes(condition)) continue;
      const resolved = resolveTarget(value, conditions, substitution);
      if (resolved !== undefined) return resolved;
    }
  }
  return undefined;
}

/**
 * What an `import` of `subpath` ("." or "./x/y") of a package resolves to through its `exports`:
 * `{ legacy: true }` when the package has no `exports` (every file is reachable, so nothing is checkable here),
 * `{ target }` with the package-relative target ("./src/x.mjs"), or `{ target: null }` when it is not exported.
 * Exact keys win; otherwise the longest-prefix `*` pattern that matches, as in Node's PACKAGE_EXPORTS_RESOLVE.
 */
export function resolveExport(exports, subpath, conditions = IMPORT_CONDITIONS) {
  const map = subpathMap(exports);
  if (map === undefined) return { legacy: true };
  if (map === null) return { target: null };
  if (Object.hasOwn(map, subpath) && !subpath.includes("*")) return { target: resolveTarget(map[subpath], conditions) ?? null };
  let best = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0 || star !== key.lastIndexOf("*")) continue;
    const prefix = key.slice(0, star), suffix = key.slice(star + 1);
    if (subpath.length < key.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (best === null || prefix.length > best.prefix.length || (prefix.length === best.prefix.length && key.length > best.key.length)) best = { key, prefix, suffix };
  }
  if (best === null) return { target: null };
  const substitution = subpath.slice(best.prefix.length, subpath.length - best.suffix.length);
  return { target: resolveTarget(map[best.key], conditions, substitution) ?? null };
}

/**
 * Every file `exports` can lead Node to, as { where, target } with `where` naming the place in the manifest
 * (`exports["./x"].import`). Only conditions Node itself resolves (import, require, node, module-sync, default)
 * are followed, since `types`, `browser`, `development` and the like may name files a package chooses not to ship.
 * An array is a list of fallbacks, so it is satisfied by any one member; its members are reported together as
 * `{ where, alternatives }`.
 */
export function exportTargets(exports) {
  const found = [];
  const visit = (target, where) => {
    if (typeof target === "string") found.push({ where, target });
    else if (Array.isArray(target)) {
      const alternatives = target.filter((item) => typeof item === "string");
      if (alternatives.length === target.length && alternatives.length > 0) found.push({ where, alternatives });
      else target.forEach((item, index) => visit(item, `${where}[${index}]`));
    } else if (record(target)) {
      for (const [condition, value] of Object.entries(target)) if (REACHABLE_CONDITIONS.has(condition)) visit(value, `${where}.${condition}`);
    }
  };
  const map = subpathMap(exports);
  if (map === undefined || map === null) return found;
  for (const [subpath, target] of Object.entries(map)) visit(target, `exports[${JSON.stringify(subpath)}]`);
  return found;
}

/** The `bin` targets of a manifest as { where, target }. */
export function binTargets(manifest) {
  if (typeof manifest.bin === "string") return [{ where: "bin", target: manifest.bin }];
  if (!record(manifest.bin)) return [];
  return Object.entries(manifest.bin).map(([command, target]) => ({ where: `bin[${JSON.stringify(command)}]`, target }));
}
