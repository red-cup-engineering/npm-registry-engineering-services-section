import { lstat, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const INSTALL_COMMAND = /\bnpm\s+(?:ci|install|i)\b/u;

function packageTarget(directory, name) {
  if (name.startsWith("@")) {
    const [scope, leaf] = name.split("/");
    return join(directory, "node_modules", scope, leaf);
  }
  return join(directory, "node_modules", name);
}

function within(root, path) {
  const relation = relative(root, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

async function manifestAt(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new TypeError(`source binding package at ${directory} has no name/version`);
  return manifest;
}

async function assertNoInstallLifecycle(packages) {
  for (const pkg of packages) {
    const manifest = await manifestAt(pkg.dir);
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new TypeError(`planned source ${pkg.name}@${pkg.version} does not match ${pkg.dir}`);
    for (const script of pkg.lifecycle) {
      if (INSTALL_COMMAND.test(manifest.scripts?.[script] ?? "")) throw new TypeError(`source-bound verification refuses ${pkg.name} lifecycle ${script}: npm installation is not permitted while bindings are active`);
    }
  }
}

/**
 * Temporarily resolves planned internal edges to their exact source directories.
 * It never changes manifests or locks; every replaced install target is restored,
 * including when the callback fails.
 */
export async function withSourceBindings(plan, run) {
  if (typeof run !== "function") throw new TypeError("source-bound verification requires a callable operation");
  await assertNoInstallLifecycle(plan.packages);
  const providers = new Map(plan.packages.map((pkg) => [pkg.name, pkg]));
  const bindings = [];
  try {
    for (const consumer of plan.packages) {
      for (const dependency of plan.dependencies[consumer.name] ?? []) {
        const provider = providers.get(dependency);
        if (provider === undefined) continue;
        const target = packageTarget(consumer.dir, dependency);
        const nodeModules = join(consumer.dir, "node_modules");
        if (!within(nodeModules, target)) throw new TypeError(`source binding target escapes node_modules: ${target}`);
        const backup = `${target}.source-binding-backup-${process.pid}-${bindings.length}`;
        let replaced = false;
        try { await lstat(target); replaced = true; } catch (error) { if (error?.code !== "ENOENT") throw error; }
        await mkdir(dirname(target), { recursive: true });
        bindings.push({ target, backup, replaced });
        if (replaced) await rename(target, backup);
        await symlink(provider.dir, target, "dir");
      }
    }
    return await run();
  } finally {
    for (const binding of bindings.reverse()) {
      await rm(binding.target, { recursive: true, force: true });
      if (binding.replaced) await rename(binding.backup, binding.target);
    }
  }
}
