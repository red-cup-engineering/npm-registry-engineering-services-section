import { readJsnodeModuleExports } from "@red-cup-engineering/javascript-node-services-section/syntax";

/**
 * Statically list the top-level exported binding names of one ECMAScript
 * module source text, by syntax alone — no execution and no dependency
 * resolution, so it stays usable against a source file whose own imports
 * cannot be resolved (an extracted historical tarball, an unbuilt package).
 * `export * from "..."` re-exports cannot be enumerated without resolving
 * and reading the named module, so they are reported separately via
 * `hasStarExport` rather than silently omitted or guessed at.
 * @param {string} sourceText ECMAScript module source text.
 * @returns {{names: readonly string[], hasStarExport: boolean}} Exported binding names in source order (deduplicated), and whether an unresolved `export *` was seen.
 * @throws {SyntaxError} When sourceText does not parse as an ECMAScript module.
 */
export function javascriptModuleExportedNames(sourceText) {
  if (typeof sourceText !== "string") throw new TypeError("sourceText must be a string");
  return readJsnodeModuleExports(sourceText, "module.mjs");
}
