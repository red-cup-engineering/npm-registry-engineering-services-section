import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { dependencyEntries } from "./workspace-graph.mjs";
import { scanWorkspaceManifests } from "./read-workspace-manifests.mjs";

const PRIMARY_LIFECYCLE = Object.freeze(["build", "check", "typecheck", "test"]);

function numericVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(value);
  return match ? match.slice(1, 4).map((part) => Number.parseInt(part ?? "0", 10)) : null;
}

export function nodeEngineEvidence(requirement, observed = process.versions.node) {
  if (requirement === undefined) return Object.freeze({ requirement: null, observed, compatible: true });
  const minimumMatch = /^>=\s*(\d+(?:\.\d+){0,2})$/u.exec(requirement);
  const actual = numericVersion(observed);
  const minimum = minimumMatch ? numericVersion(minimumMatch[1]) : null;
  if (!actual || !minimum) return Object.freeze({ requirement, observed, compatible: false, reason: "unsupported Node engine requirement" });
  const compatible = actual[0] > minimum[0]
    || (actual[0] === minimum[0] && actual[1] > minimum[1])
    || (actual[0] === minimum[0] && actual[1] === minimum[1] && actual[2] >= minimum[2]);
  return Object.freeze({ requirement, observed, compatible, ...(compatible ? {} : { reason: "running Node is older than the package minimum" }) });
}

export function lifecycleScripts(manifest) {
  const scripts = manifest?.scripts ?? {};
  const selected = PRIMARY_LIFECYCLE.filter((name) => typeof scripts[name] === "string");
  if (selected.length === 0 && typeof scripts.verify === "string") selected.push("verify");
  return Object.freeze(selected);
}

export function declaredBins(manifest) {
  if (typeof manifest?.bin === "string") {
    return Object.freeze([{ name: manifest.name ?? "<unnamed>", path: manifest.bin }]);
  }
  if (!manifest?.bin || Object.getPrototypeOf(manifest.bin) !== Object.prototype) return Object.freeze([]);
  return Object.freeze(Object.entries(manifest.bin).map(([name, path]) => ({ name, path })));
}

export function softwareKind(manifest) {
  if (declaredBins(manifest).length > 0) return "executable";
  if (manifest?.exports !== undefined || manifest?.main !== undefined || manifest?.module !== undefined) return "library";
  if (lifecycleScripts(manifest).length > 0) return "checked-aggregate";
  return "aggregate";
}

/** True only when a manifest names what npm should carry across a machine boundary. */
export function hasPublicationSurface(manifest) {
  return declaredBins(manifest).length > 0
    || manifest?.exports !== undefined
    || manifest?.main !== undefined
    || manifest?.module !== undefined
    || manifest?.types !== undefined
    || (Array.isArray(manifest?.files) && manifest.files.length > 0);
}

async function binEvidence(dir, bin, manifest) {
  if (typeof bin.path !== "string" || bin.path.length === 0 || isAbsolute(bin.path)) {
    return Object.freeze({ ...bin, exists: false, status: "missing-source", reason: "bin path must be one non-empty package-relative path" });
  }
  try {
    await access(resolve(dir, bin.path));
    return Object.freeze({ ...bin, exists: true, status: "available" });
  } catch {
    const generatedByBuild = typeof manifest?.scripts?.build === "string";
    return Object.freeze({
      ...bin,
      exists: false,
      status: generatedByBuild ? "pending-build" : "missing-source",
      reason: generatedByBuild
        ? "declared bin is absent before the package build"
        : "declared bin file is absent and the package has no build script",
    });
  }
}

export async function censusActiveSoftware(root) {
  const manifests = await scanWorkspaceManifests(root);
  const packages = [];
  for (const row of manifests) {
    const bins = await Promise.all(declaredBins(row.manifest).map((bin) => binEvidence(row.dir, bin, row.manifest)));
    let dependencies = {}, dependencyError;
    try { dependencies = Object.fromEntries(dependencyEntries(row.manifest ?? {})); }
    catch (error) { dependencyError = error.message; }
    packages.push(Object.freeze({
      path: row.path,
      dir: row.dir,
      name: row.manifest?.name ?? null,
      version: row.manifest?.version ?? null,
      private: row.manifest?.private === true,
      kind: softwareKind(row.manifest),
      nodeEngine: nodeEngineEvidence(row.manifest?.engines?.node),
      lifecycle: lifecycleScripts(row.manifest),
      dependencies: Object.freeze(dependencies),
      ...(dependencyError ? { dependencyError } : {}),
      bins: Object.freeze(bins),
    }));
  }
  return Object.freeze(packages);
}

export function summarizeSoftwareCensus(packages) {
  const summary = {
    manifests: packages.length,
    executable: 0,
    library: 0,
    checkedAggregate: 0,
    aggregate: 0,
    lifecycleCommands: 0,
    declaredBins: 0,
    absentBins: 0,
    pendingBuildBins: 0,
    missingSourceBins: 0,
    incompatibleNodeEngines: 0,
  };
  for (const pkg of packages) {
    if (pkg.kind === "executable") summary.executable += 1;
    else if (pkg.kind === "library") summary.library += 1;
    else if (pkg.kind === "checked-aggregate") summary.checkedAggregate += 1;
    else summary.aggregate += 1;
    summary.lifecycleCommands += pkg.lifecycle.length;
    summary.declaredBins += pkg.bins.length;
    summary.absentBins += pkg.bins.filter(({ exists }) => !exists).length;
    summary.pendingBuildBins += pkg.bins.filter(({ status }) => status === "pending-build").length;
    summary.missingSourceBins += pkg.bins.filter(({ status }) => status === "missing-source").length;
    if (!pkg.nodeEngine.compatible) summary.incompatibleNodeEngines += 1;
  }
  return Object.freeze(summary);
}
