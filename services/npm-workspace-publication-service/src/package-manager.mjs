/** Detects which package manager a package's own manifest and lockfile name it, and gives the
 *  exact fresh-install argv for that manager, so the publish gate installs every package the
 *  way its own scripts already assume rather than forcing npm on a pnpm- or yarn-managed tree. */

/** Lockfile name -> the package manager that owns it, in the order checked. */
export const MANAGER_LOCKFILES = Object.freeze([
  Object.freeze({ file: "pnpm-lock.yaml", manager: "pnpm" }),
  Object.freeze({ file: "yarn.lock", manager: "yarn" }),
  Object.freeze({ file: "package-lock.json", manager: "npm" }),
]);

/** Whether the selected manager has its own committed lockfile. */
export function hasPackageManagerLockfile(manager, presentFiles) {
  const lockfile = MANAGER_LOCKFILES.find((entry) => entry.manager === manager)?.file;
  return lockfile !== undefined && presentFiles.includes(lockfile);
}

/**
 * Name the package manager a package's own manifest or lockfile declares. A `packageManager`
 * field (Corepack's `"pnpm@9.0.0"` shape) wins when present; otherwise the first lockfile the
 * directory listing carries wins, in `MANAGER_LOCKFILES` order; a package with neither defaults
 * to `npm`, the house baseline.
 * @param {{ manifest?: {packageManager?: string}, presentFiles: readonly string[] }} input
 * @returns {"npm"|"pnpm"|"yarn"}
 */
export function detectPackageManager({ manifest, presentFiles }) {
  const declared = typeof manifest?.packageManager === "string" ? manifest.packageManager.split("@")[0].trim() : null;
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  const files = new Set(presentFiles);
  for (const { file, manager } of MANAGER_LOCKFILES) {
    if (files.has(file)) return manager;
  }
  return "npm";
}

/**
 * The exact registry-pinned install argv for one package manager and one
 * manifest state. `verify` proves the committed lock still resolves the
 * manifest; `update-lock` is only for a manifest whose exact dependency pin
 * just changed. Neither mode deletes a lockfile: it is package evidence, and
 * removing it could silently replace unrelated resolutions.
 * @param {"npm"|"pnpm"|"yarn"} manager
 * @param {string} registry
 * @param {"verify"|"update-lock"} mode
 * @param {{cacheRoot?: string, preferOffline?: boolean}} [options] `cacheRoot` is an isolated verification cache shared only within this release (PNPM release-age quarantine is disabled here because the house gate verifies newly published exact pins immediately). `preferOffline` instead resolves from the manager's own standing cache before the registry: the fallback for a consumer whose transitive tarball the registry no longer serves but the cache still holds. The two are exclusive; an isolated cache has nothing to fall back on.
 * @returns {{ command: string, arguments: readonly string[] }}
 */
export function packageManagerInstallCommand(manager, registry, mode, { cacheRoot, preferOffline = false } = {}) {
  if (mode !== "verify" && mode !== "update-lock") throw new TypeError(`package-manager: unknown install mode ${JSON.stringify(mode)}`);
  if (cacheRoot !== undefined && (typeof cacheRoot !== "string" || cacheRoot.length === 0)) throw new TypeError("cacheRoot must be a nonempty path");
  if (cacheRoot !== undefined && preferOffline) throw new TypeError("preferOffline cannot combine with an isolated cacheRoot");
  const cache = preferOffline
    ? (manager === "pnpm" ? ["--config.prefer-offline=true"] : ["--prefer-offline"])
    : !cacheRoot ? [] : manager === "pnpm"
      ? ["--cache-dir", `${cacheRoot}/pnpm-metadata`, "--store-dir", `${cacheRoot}/pnpm-store`, "--config.prefer-offline=false", "--config.minimumReleaseAge=0"]
      : manager === "yarn" ? ["--cache-folder", `${cacheRoot}/yarn`] : ["--cache", `${cacheRoot}/npm`, "--prefer-online"];
  if (manager === "npm") {
    return Object.freeze({ command: "npm", arguments: Object.freeze(mode === "verify"
      ? ["ci", "--no-audit", "--no-fund", "--registry", registry, ...cache]
      : ["install", "--no-audit", "--no-fund", "--registry", registry, ...cache]) });
  }
  if (manager === "pnpm") {
    return Object.freeze({ command: "pnpm", arguments: Object.freeze(["install", ...(mode === "verify" ? ["--frozen-lockfile"] : ["--no-frozen-lockfile"]), "--registry", registry, ...cache]) });
  }
  if (manager === "yarn") {
    return Object.freeze({ command: "yarn", arguments: Object.freeze(["install", ...(mode === "verify" ? ["--frozen-lockfile"] : []), "--registry", registry, ...cache]) });
  }
  throw new TypeError(`package-manager: unknown manager ${JSON.stringify(manager)}`);
}
