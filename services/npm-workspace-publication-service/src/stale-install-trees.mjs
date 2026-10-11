import { execFile } from "node:child_process";
import { readdir, readFile, lstat, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const LOCKFILE_NAMES = Object.freeze(["package-lock.json", "npm-shrinkwrap.json"]);

/**
 * Sum the byte size of every regular file and symlink reachable under `dir`
 * by a plain recursive directory walk (no `du` shell-out; symlinks are
 * measured by their own lstat size, never followed, so a cyclic or
 * dangling link cannot loop or throw).
 * @param {string} dir Directory to size.
 * @returns {Promise<number>} Total bytes.
 */
export async function directoryByteSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      try {
        const info = await lstat(path);
        total += info.size;
      } catch {
        // races (file removed mid-walk) contribute nothing, not a crash
      }
    }
  }
  return total;
}

/**
 * Find every `node_modules` directory under `root` that is not itself
 * nested inside another `node_modules` directory, pairing each with its
 * owning package directory (the parent).
 * @param {string} root Directory to search.
 * @returns {Promise<readonly {nodeModulesDir: string, packageDir: string}[]>}
 */
export async function findTopLevelNodeModulesTrees(root) {
  const found = [];
  const stack = [resolve(root)];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.name === "node_modules") {
        found.push({ nodeModulesDir: path, packageDir: current });
        continue;
      }
      stack.push(path);
    }
  }
  return found;
}

/**
 * Read a JSON file, returning `null` on any missing-file or parse failure
 * rather than throwing, since absence is an ordinary classification input.
 * @param {string} path File to read.
 * @returns {Promise<object|null>}
 */
async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether a package directory carries a lockfile it can be reinstalled from.
 * @param {string} packageDir Package directory.
 * @returns {Promise<boolean>}
 */
export async function hasLockfile(packageDir) {
  for (const name of LOCKFILE_NAMES) {
    try {
      await lstat(join(packageDir, name));
      return true;
    } catch {
      // try the next lockfile name
    }
  }
  return false;
}

/**
 * Walk ancestors of `packageDir`, stopping at (and including) `root`, for
 * the nearest manifest declaring an npm `workspaces` field — the marker
 * that `packageDir` is a nested workspace member whose install is owned by
 * that ancestor's lockfile, not its own.
 * @param {string} packageDir Package directory to search upward from.
 * @param {string} root Upper bound of the search, inclusive.
 * @returns {Promise<{ancestor: string}|null>}
 */
export async function nestedWorkspaceOwner(packageDir, root) {
  const resolvedRoot = resolve(root);
  let cursor = dirname(resolve(packageDir));
  while (true) {
    const manifest = await readJsonOrNull(join(cursor, "package.json"));
    if (manifest && typeof manifest === "object" && manifest.workspaces) {
      return { ancestor: cursor };
    }
    if (cursor === resolvedRoot || cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
  }
  return null;
}

/**
 * Whether git considers `dir` recently touched: a commit within `days`, or
 * uncommitted changes right now. Runs against the repository rooted at
 * `repoRoot`; a directory outside any repository, or a git failure, is
 * reported as not-recent rather than thrown, since recency is only ever a
 * `keep` signal (absence of git history never manufactures a prune).
 * @param {string} repoRoot Git working tree root to run commands from.
 * @param {string} dir Directory (absolute) to check.
 * @param {number} days Recency window in days.
 * @returns {Promise<{recent: boolean, reason: string|null}>}
 */
export async function gitRecentActivity(repoRoot, dir, days) {
  const cutoffSeconds = Math.floor(Date.now() / 1000) - days * 86400;
  try {
    const { stdout: porcelain } = await run("git", ["-C", repoRoot, "status", "--porcelain", "--", dir]);
    if (porcelain.trim().length > 0) return { recent: true, reason: "uncommitted changes in working tree" };
  } catch {
    // no repository or git unavailable at repoRoot: fall through
  }
  try {
    const { stdout } = await run("git", ["-C", repoRoot, "log", "-1", "--format=%ct", "--", dir]);
    const commitSeconds = Number.parseInt(stdout.trim(), 10);
    if (Number.isFinite(commitSeconds) && commitSeconds >= cutoffSeconds) {
      return { recent: true, reason: `git commit within ${days} day(s)` };
    }
  } catch {
    // no repository, no history for this path, or git unavailable
  }
  return { recent: false, reason: null };
}

/**
 * Whether any unit file under `unitsDir` names `dir` in a `WorkingDirectory=`
 * or `ExecStart=` line, meaning a running or installed systemd user unit
 * depends on the package directory staying installed.
 * @param {string} unitsDir Directory of systemd user unit files.
 * @param {string} dir Package directory (absolute) to search for.
 * @returns {Promise<string|null>} The referencing unit file name, or null.
 */
export async function systemdUnitReference(unitsDir, dir) {
  let entries;
  try {
    entries = await readdir(unitsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    let text;
    try {
      text = await readFile(join(unitsDir, entry.name), "utf8");
    } catch {
      continue;
    }
    const referencing = text.split("\n").some((line) => {
      const trimmed = line.trim();
      return (trimmed.startsWith("WorkingDirectory=") || trimmed.startsWith("ExecStart=")) && trimmed.includes(dir);
    });
    if (referencing) return entry.name;
  }
  return null;
}

/**
 * Whether an MCP configuration file's JSON text names `dir` anywhere
 * (server `cwd`, `args`, or `env` values commonly carry a package path).
 * @param {string} mcpConfigPath Path to the MCP config JSON file.
 * @param {string} dir Package directory (absolute) to search for.
 * @returns {Promise<boolean>}
 */
export async function mcpConfigReference(mcpConfigPath, dir) {
  let text;
  try {
    text = await readFile(mcpConfigPath, "utf8");
  } catch {
    return false;
  }
  return text.includes(dir);
}

/**
 * Classify one discovered install tree as `keep` or `prune`, checking the
 * five keep conditions in a fixed order and reporting the first that fires
 * as `reason`. Absence of a lockfile and nested-workspace ownership are
 * refusals (kept because pruning would be non-deterministic or would break
 * a shared install), not evidence of use.
 * @param {object} input
 * @param {string} input.nodeModulesDir Absolute path to the `node_modules` directory.
 * @param {string} input.packageDir Absolute path to the owning package directory.
 * @param {string} input.root Scan root, for nested-workspace bounding.
 * @param {number} input.days Recency window in days.
 * @param {string} input.unitsDir Systemd user unit directory to check.
 * @param {string} input.mcpConfigPath MCP config file path to check.
 * @returns {Promise<{decision: "keep"|"prune", reason: string}>}
 */
export async function classifyInstallTree({ nodeModulesDir, packageDir, root, days, unitsDir, mcpConfigPath }) {
  const git = await gitRecentActivity(root, packageDir, days);
  if (git.recent) return { decision: "keep", reason: git.reason };

  const unit = await systemdUnitReference(unitsDir, packageDir);
  if (unit) return { decision: "keep", reason: `referenced by systemd user unit ${unit}` };

  if (await mcpConfigReference(mcpConfigPath, packageDir)) {
    return { decision: "keep", reason: "referenced by .mcp.json" };
  }

  if (!(await hasLockfile(packageDir))) {
    return { decision: "keep", reason: "no lockfile: cannot reinstall deterministically, refusing to prune" };
  }

  const workspace = await nestedWorkspaceOwner(packageDir, root);
  if (workspace) {
    return { decision: "keep", reason: `nested workspace member owned by root lockfile at ${workspace.ancestor}` };
  }

  return { decision: "prune", reason: `no activity within ${days} day(s), no reference, has lockfile, not workspace-owned` };
}

/**
 * The package name to report for a discovered install tree: the manifest's
 * declared name when present, else the directory's own basename.
 * @param {string} packageDir Package directory.
 * @returns {Promise<string>}
 */
async function packageNameFor(packageDir) {
  const manifest = await readJsonOrNull(join(packageDir, "package.json"));
  if (manifest && typeof manifest.name === "string" && manifest.name !== "") return manifest.name;
  return packageDir.split(sep).filter(Boolean).pop() ?? packageDir;
}

/**
 * Derive the full stale-install-tree report for a directory tree: every
 * top-level `node_modules`, sized, classified `keep`/`prune`, sorted by
 * prune-candidate size descending.
 * @param {object} input
 * @param {string} input.root Directory to scan.
 * @param {number} [input.days] Recency window in days.
 * @param {string} [input.unitsDir] Systemd user unit directory.
 * @param {string} [input.mcpConfigPath] MCP config file path.
 * @returns {Promise<{kind: "npm.stale-install-trees", days: number, trees: readonly object[], totals: {keep: number, prune: number, pruneBytes: number}}>}
 */
export async function deriveStaleInstallTreesReport({
  root,
  days = 30,
  unitsDir = join(process.env.HOME ?? "", ".config", "systemd", "user"),
  mcpConfigPath = "/home/emsenn/info/.mcp.json",
}) {
  const resolvedRoot = resolve(root);
  const found = await findTopLevelNodeModulesTrees(resolvedRoot);
  const trees = [];
  for (const { nodeModulesDir, packageDir } of found) {
    const [bytes, packageName, classification] = await Promise.all([
      directoryByteSize(nodeModulesDir),
      packageNameFor(packageDir),
      classifyInstallTree({ nodeModulesDir, packageDir, root: resolvedRoot, days, unitsDir, mcpConfigPath }),
    ]);
    trees.push({
      dir: nodeModulesDir,
      package: packageName,
      bytes,
      decision: classification.decision,
      reason: classification.reason,
    });
  }
  trees.sort((a, b) => {
    const aPrune = a.decision === "prune" ? a.bytes : -1;
    const bPrune = b.decision === "prune" ? b.bytes : -1;
    return bPrune - aPrune;
  });
  const totals = trees.reduce(
    (acc, tree) => {
      if (tree.decision === "keep") acc.keep += 1;
      else {
        acc.prune += 1;
        acc.pruneBytes += tree.bytes;
      }
      return acc;
    },
    { keep: 0, prune: 0, pruneBytes: 0 },
  );
  return { kind: "npm.stale-install-trees", days, trees, totals };
}

/**
 * Remove every `prune`-classified tree's `node_modules` directory.
 * @param {readonly {dir: string, decision: "keep"|"prune", bytes: number}[]} trees Classified trees.
 * @returns {Promise<{removed: number, bytes: number}>}
 */
export async function removePruneTrees(trees) {
  let removed = 0;
  let bytes = 0;
  for (const tree of trees) {
    if (tree.decision !== "prune") continue;
    await rm(tree.dir, { recursive: true, force: true });
    removed += 1;
    bytes += tree.bytes;
  }
  return { removed, bytes };
}
