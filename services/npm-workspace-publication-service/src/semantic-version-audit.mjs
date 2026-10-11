import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { semanticVersionPolicyViolations, manifestRole } from "./semantic-version-policy.mjs";
import { scanWorkspaceManifests } from "./read-workspace-manifests.mjs";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";

function findingDigest(findings) {
  return makeNiUri(Buffer.from(JSON.stringify(findings), "utf8"));
}

export async function auditSemanticVersionPolicy(root, { names = [], prefix = null } = {}) {
  const resolvedRoot = resolve(root);
  const selectedNames = new Set(names);
  if (selectedNames.size > 0 && prefix !== null) throw new TypeError("names and prefix are mutually exclusive");

  const allSites = await scanWorkspaceManifests(resolvedRoot);
  const sites = allSites.filter(({ manifest }) => {
    const name = manifest?.name;
    return selectedNames.size > 0
      ? selectedNames.has(name)
      : prefix === null || typeof name === "string" && name.startsWith(prefix);
  });
  const findings = [];
  let exempt = 0;
  for (const site of sites) {
    const repositoryPath = relative(resolvedRoot, site.path);
    const role = manifestRole(site.manifest);
    if (role === "section-metadata" || role === "metadata") {
      exempt += 1;
      continue;
    }
    let lock;
    try {
      lock = JSON.parse(await readFile(join(site.dir, "package-lock.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        findings.push({ path: repositoryPath, name: site.manifest?.name ?? null, role, violations: [{ field: "package-lock.json", reason: "package-lock.json is not valid JSON" }] });
        continue;
      }
    }
    const violations = semanticVersionPolicyViolations(site.manifest, lock);
    if (violations.length > 0) findings.push({ path: repositoryPath, name: site.manifest?.name ?? null, role, violations });
  }
  return Object.freeze({ root: resolvedRoot, scanned: sites.length, exempt, findings: Object.freeze(findings) });
}

export function summarizeSemanticVersionPolicyAudit(audit, { sampleLimit = 8 } = {}) {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) throw new TypeError("sampleLimit must be a nonnegative integer");
  const violationCount = audit.findings.reduce((count, finding) => count + finding.violations.length, 0);
  const reasons = new Map();
  for (const finding of audit.findings) {
    for (const violation of finding.violations) reasons.set(violation.reason, (reasons.get(violation.reason) ?? 0) + 1);
  }
  return Object.freeze({
    profile: "org.emsenn.semantic-version-policy-audit.v1",
    root: audit.root,
    scanned: audit.scanned,
    exempt: audit.exempt,
    compliant: audit.scanned - audit.exempt - audit.findings.length,
    findingCount: audit.findings.length,
    violationCount,
    findingsDigest: findingDigest(audit.findings),
    reasonCounts: Object.freeze([...reasons.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => Object.freeze({ reason, count }))),
    findingSamples: Object.freeze(audit.findings.slice(0, sampleLimit).map(({ path, name, role, violations }) => Object.freeze({ path, name, role, violations }))),
    limits: Object.freeze([
      "The audit checks npm carrier identity, exact dependency specifications, stable-to-prerelease dependency separation, and present lock-root identity within the scanned filesystem root.",
      "It does not infer API compatibility or a major, minor, or patch bump.",
      "It does not authorize or prove registry publication, promotion, deployment, Git tags, or non-npm version schemes.",
    ]),
  });
}
