import { relative, resolve, sep } from "node:path";

const DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);

export const STANDARD_OWNER_NAMESPACE_POLICIES = Object.freeze([
  Object.freeze({ section: "engineering", directory: "engineering-services-section", scope: "@red-cup-engineering/" }),
  Object.freeze({ section: "operations", directory: "operations-services-section", scope: "@coesite-operations/" }),
  Object.freeze({ section: "science", directory: "science-services-section", scope: "@lenticule-science/" }),
]);

function packageLeaf(name) {
  return name.startsWith("@") && name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
}

function scopeOf(name) {
  return name.startsWith("@") && name.includes("/") ? name.slice(0, name.indexOf("/")) : null;
}

function isWithin(candidate, root) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function dependencyAssertions(rows) {
  const assertions = [];
  for (const row of rows) {
    if (typeof row.manifest?.name !== "string") continue;
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, specification] of Object.entries(row.manifest[field] ?? {})) {
        assertions.push(Object.freeze({ consumer: row.manifest.name, dependency, field, specification }));
      }
    }
  }
  return Object.freeze(assertions);
}

/**
 * Read the live package carrier graph and state namespace debt without changing
 * an identity. Registry publication, lock reconciliation, and import migration
 * remain separate operations because an npm name is a distributed identity.
 */
export async function auditOwnerNamespaceDebt(servicesRoot, {
  policies = STANDARD_OWNER_NAMESPACE_POLICIES,
  scan,
} = {}) {
  if (typeof scan !== "function") throw new TypeError("auditOwnerNamespaceDebt: scan is required");
  const root = resolve(servicesRoot);
  const rows = await scan(root);
  const named = rows.filter(({ manifest }) => typeof manifest?.name === "string" && manifest.name.length > 0);
  const names = new Map();
  for (const row of named) {
    const sites = names.get(row.manifest.name) ?? [];
    sites.push(row);
    names.set(row.manifest.name, sites);
  }
  const assertions = dependencyAssertions(named);
  const normalizedPolicies = policies.map((policy) => Object.freeze({
    ...policy,
    root: resolve(root, policy.directory),
  }));
  const findings = [];
  for (const row of named) {
    const policy = normalizedPolicies.find(({ root: sectionRoot }) => isWithin(row.dir, sectionRoot));
    if (!policy || row.manifest.name.startsWith(policy.scope)) continue;
    const proposedName = `${policy.scope}${packageLeaf(row.manifest.name)}`;
    const consumers = assertions
      .filter(({ dependency }) => dependency === row.manifest.name)
      .map(({ consumer, field, specification }) => Object.freeze({ consumer, field, specification }))
      .sort((a, b) => a.consumer.localeCompare(b.consumer) || a.field.localeCompare(b.field));
    const targetSites = (names.get(proposedName) ?? []).map(({ path }) => relative(root, path)).sort();
    const reasons = [
      ...(targetSites.length > 0 ? ["proposed identity already exists"] : []),
      ...(consumers.length > 0 ? ["active manifests still consume the current identity"] : []),
      ...((names.get(row.manifest.name) ?? []).length > 1 ? ["current identity has multiple active manifests"] : []),
    ];
    findings.push(Object.freeze({
      section: policy.section,
      path: relative(root, row.path),
      currentName: row.manifest.name,
      currentScope: scopeOf(row.manifest.name),
      proposedName,
      version: row.manifest.version ?? null,
      consumers: Object.freeze(consumers),
      proposedIdentitySites: Object.freeze(targetSites),
      migrationClass: reasons.length === 0 ? "manifest-isolated" : "coupled",
      blockers: Object.freeze(reasons),
    }));
  }
  findings.sort((a, b) => a.section.localeCompare(b.section) || a.currentName.localeCompare(b.currentName) || a.path.localeCompare(b.path));
  const bySection = Object.fromEntries(normalizedPolicies.map(({ section }) => {
    const sectionRows = named.filter(({ dir }) => isWithin(dir, normalizedPolicies.find((policy) => policy.section === section).root));
    const sectionFindings = findings.filter((finding) => finding.section === section);
    return [section, Object.freeze({
      packages: sectionRows.length,
      compliant: sectionRows.length - sectionFindings.length,
      violations: sectionFindings.length,
      old561Group: sectionFindings.filter(({ currentScope }) => currentScope === "@561-group").length,
      manifestIsolated: sectionFindings.filter(({ migrationClass }) => migrationClass === "manifest-isolated").length,
      coupled: sectionFindings.filter(({ migrationClass }) => migrationClass === "coupled").length,
    })];
  }));
  return Object.freeze({
    kind: "npm-workspace.owner-namespace-debt",
    servicesRoot: ".",
    policies: Object.freeze(normalizedPolicies.map(({ section, directory, scope }) => Object.freeze({ section, directory, scope }))),
    summary: Object.freeze({
      activeManifests: rows.length,
      namedPackages: named.length,
      violations: findings.length,
      manifestIsolated: findings.filter(({ migrationClass }) => migrationClass === "manifest-isolated").length,
      coupled: findings.filter(({ migrationClass }) => migrationClass === "coupled").length,
      dependencyAssertionsToCurrentIdentities: findings.reduce((total, finding) => total + finding.consumers.length, 0),
      bySection: Object.freeze(bySection),
    }),
    findings: Object.freeze(findings),
  });
}
