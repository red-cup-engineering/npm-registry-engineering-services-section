/**
 * Whether a package's shipped build output is stale against its source: the
 * deterministic check behind the `dist-stale` publish-gate refusal. A
 * package whose `files` manifest names a built directory (`dist`) and whose
 * `prepack`/`build` script regenerates it must never ship an artifact older
 * than the source it was built from — a stale artifact means the build did
 * not actually run, or ran against the wrong tree.
 * @param {object} input
 * @param {readonly {path: string, mtimeMs: number}[]} input.sourceFiles Files under the package's `src/` tree (or `[]` when it has none), excluding `node_modules` and tests.
 * @param {readonly {path: string, mtimeMs: number}[]} input.builtFiles Files under the package's `files` manifest entries that are directories (or `[]` when it ships none).
 * @returns {{stale: boolean, newestSource: {path: string, mtimeMs: number}|null, oldestBuilt: {path: string, mtimeMs: number}|null}} `stale` is always `false` when either listing is empty — there is nothing to compare, so nothing to refuse.
 */
export function classifyDistStaleness({ sourceFiles, builtFiles }) {
  const newestSource = sourceFiles.reduce((newest, file) => (newest === null || file.mtimeMs > newest.mtimeMs ? file : newest), null);
  const oldestBuilt = builtFiles.reduce((oldest, file) => (oldest === null || file.mtimeMs < oldest.mtimeMs ? file : oldest), null);
  if (newestSource === null || oldestBuilt === null) {
    return Object.freeze({ stale: false, newestSource, oldestBuilt });
  }
  return Object.freeze({ stale: oldestBuilt.mtimeMs < newestSource.mtimeMs, newestSource, oldestBuilt });
}
