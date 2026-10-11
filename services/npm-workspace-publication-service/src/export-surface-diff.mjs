/**
 * Classify a candidate release against the file set and per-subpath exported
 * binding names it published previously. `additive` requires every
 * previously shipped file THAT WAS PART OF THE PREVIOUS RELEASE'S EXPORT
 * SURFACE to still be shipped, and every previously exported binding name, at
 * every subpath that still exists, to still be exported; anything else is
 * `breaking`. A subpath that carried exports and has been removed entirely
 * counts every one of its previous names as missing. A removed file outside
 * `reachableFiles` (a stray build artifact, a dropped internal module never
 * named by `exports`/`bin`/`main`) is an orphan: no declared promise reaches
 * it, so dropping it cannot break a consumer and is reported separately,
 * never folded into `removedFiles`. Omitting `reachableFiles` (its absence,
 * not an empty array) is the conservative default — every removed file
 * counts as breaking, matching the classifier's original behavior — for a
 * caller that has not computed the previous manifest's export surface.
 * @param {object} input
 * @param {readonly string[]} input.previousFiles Files the currently published tarball shipped.
 * @param {readonly string[]} input.currentFiles Files the candidate tarball would ship.
 * @param {readonly {subpath: string, previousNames: readonly string[]|null, currentNames: readonly string[]|null}[]} input.exportDiffs One entry per JavaScript export subpath present previously, currently, or both; `null` names mean "could not be read" and are never treated as a removal.
 * @param {readonly string[]} [input.reachableFiles] The previously published manifest's export surface (`packageExportSurfacePaths`); when given, a removed file outside this set is classified as an orphan, not a break.
 * @returns {{classification: "additive"|"breaking", removedFiles: readonly string[], orphanRemovedFiles: readonly string[], missingExports: readonly {subpath: string, name: string}[]}}
 */
export function classifyExportSurfaceDiff({ previousFiles, currentFiles, exportDiffs, reachableFiles = null }) {
  const currentFileSet = new Set(currentFiles);
  const allRemovedFiles = [...new Set(previousFiles)].filter((file) => !currentFileSet.has(file)).sort();
  const reachableSet = reachableFiles === null ? null : new Set(reachableFiles);
  const removedFiles = reachableSet === null ? allRemovedFiles : allRemovedFiles.filter((file) => reachableSet.has(file));
  const orphanRemovedFiles = reachableSet === null ? [] : allRemovedFiles.filter((file) => !reachableSet.has(file));
  const missingExports = [];
  for (const { subpath, previousNames, currentNames } of exportDiffs) {
    if (!previousNames) continue;
    const currentSet = new Set(currentNames ?? []);
    for (const name of previousNames) {
      if (!currentSet.has(name)) missingExports.push(Object.freeze({ subpath, name }));
    }
  }
  const classification = removedFiles.length === 0 && missingExports.length === 0 ? "additive" : "breaking";
  return Object.freeze({
    classification,
    removedFiles: Object.freeze(removedFiles),
    orphanRemovedFiles: Object.freeze(orphanRemovedFiles),
    missingExports: Object.freeze(missingExports),
  });
}
