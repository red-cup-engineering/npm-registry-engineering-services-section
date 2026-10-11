import { internalDependencyGraph, leafFirstTiers, workspaceDependencyClosure } from "./workspace-graph.mjs";

/** @typedef {import("./software-verification.mjs").VerificationPackage} VerificationPackage */
/**
 * Pure scheduling over exact source identities. Registry pins that differ from
 * a source version remain external edges: executing newer source is no proof
 * about the installed older artifact.
 * @param {readonly VerificationPackage[]} census
 * @param {{packages?: readonly string[], includeDependencies?: boolean}} options
 */
export function planSoftwareVerification(census, { packages = [], includeDependencies = false } = {}) {
  const all = census.map((pkg) => Object.freeze({ ...pkg, name: pkg.name ?? pkg.path }));
  const names = new Set(all.map((pkg) => pkg.name));
  for (const name of packages) if (!names.has(name)) throw new TypeError(`requested package is absent: ${name}`);
  const selected = packages.length === 0 ? all : includeDependencies
    ? workspaceDependencyClosure(all, packages)
    : all.filter((pkg) => packages.includes(pkg.name));
  const selectedNames = new Set();
  for (const pkg of selected) {
    if (pkg.dependencyError) throw new TypeError(pkg.dependencyError);
    if (selectedNames.has(pkg.name)) throw new TypeError(`duplicate package identity: ${pkg.name}`);
    selectedNames.add(pkg.name);
  }
  const { edges } = internalDependencyGraph(selected);
  const { tiers, cyclic } = leafFirstTiers(selected);
  return Object.freeze({
    packages: Object.freeze(selected),
    tiers,
    cyclic,
    dependencies: Object.freeze(Object.fromEntries(edges)),
    lifecycleJobs: selected.reduce((sum, pkg) => sum + pkg.lifecycle.length, 0),
  });
}

/**
 * Run separate packages concurrently, never separate lifecycle stages of one
 * package. A failed prerequisite blocks only its dependents; independent work
 * continues. The injected runner owns processes, clocks and output retention.
 * @param {ReturnType<typeof planSoftwareVerification>} plan
 * @param {{concurrency?: number, run: (job: import("./software-verification.mjs").VerificationJob) => Promise<import("./software-verification.mjs").CommandResult>}} options
 */
export async function executeSoftwareVerification(plan, { concurrency = 2, run }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be a positive integer");
  if (typeof run !== "function") throw new TypeError("run must be a callable effect");
  const byName = new Map(plan.packages.map((pkg) => [pkg.name, pkg]));
  const states = new Map();
  const results = [];
  for (const tier of plan.tiers) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, tier.length) }, async () => {
      while (cursor < tier.length) {
        const name = tier[cursor++];
        const pkg = byName.get(name);
        const blockedBy = plan.dependencies[name].filter((dep) => states.get(dep) !== "passed");
        let failed = blockedBy.length > 0;
        for (const script of pkg.lifecycle) {
          const job = { package: name, dir: pkg.dir, path: pkg.path, script };
          if (failed) {
            results.push({ ...job, status: "blocked", blockedBy: blockedBy.length ? blockedBy : [name] });
            continue;
          }
          let result;
          try { result = await run(job); }
          catch (error) { result = { status: "failed-to-start", error: String(error?.message ?? error) }; }
          results.push({ ...job, ...result });
          failed = result.status !== "passed";
        }
        states.set(name, failed ? "failed" : "passed");
      }
    }));
  }
  for (const name of plan.cyclic) {
    const pkg = byName.get(name);
    states.set(name, "blocked");
    for (const script of pkg.lifecycle) results.push({ package: name, dir: pkg.dir, path: pkg.path, script, status: "blocked", blockedBy: plan.cyclic });
  }
  return Object.freeze({
    results: Object.freeze(results.sort((a, b) => a.package.localeCompare(b.package) || byName.get(a.package).lifecycle.indexOf(a.script) - byName.get(b.package).lifecycle.indexOf(b.script))),
    packageStates: Object.freeze(Object.fromEntries(states)),
    ok: [...states.values()].every((state) => state === "passed"),
  });
}
