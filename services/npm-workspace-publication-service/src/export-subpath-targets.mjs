function conditionTarget(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return conditionTarget(value.import ?? value.node ?? value.default ?? null);
}

/**
 * List the concrete (non-wildcard) JavaScript file targets a manifest's
 * `exports` map (or its `main` fallback) declares, keyed by import subpath.
 * Only targets ending `.mjs`/`.js` are returned — a `./package.json` export
 * or a `.d.ts`-only condition carries no exported JavaScript bindings to
 * diff. A subpath containing `*` is a wildcard family, not one concrete
 * file, and is excluded.
 * @param {object} manifest A parsed package.json document.
 * @returns {readonly {subpath: string, target: string}[]} Concrete JavaScript export targets in manifest order.
 */
export function concreteJavascriptExportTargets(manifest) {
  const exports = manifest?.exports;
  const entries = [];
  if (typeof exports === "string") {
    entries.push([".", exports]);
  } else if (exports !== null && typeof exports === "object" && !Array.isArray(exports)) {
    const keys = Object.keys(exports);
    if (keys.every((key) => !key.startsWith("."))) {
      const target = conditionTarget(exports);
      if (target !== null) entries.push([".", target]);
    } else {
      for (const key of keys) {
        if (key.includes("*")) continue;
        const target = conditionTarget(exports[key]);
        if (target !== null) entries.push([key === "." ? "." : key, target]);
      }
    }
  } else if (typeof manifest?.main === "string") {
    entries.push([".", manifest.main]);
  }
  return Object.freeze(entries
    .filter(([, target]) => /\.m?js$/u.test(target))
    .map(([subpath, target]) => Object.freeze({ subpath, target })));
}
