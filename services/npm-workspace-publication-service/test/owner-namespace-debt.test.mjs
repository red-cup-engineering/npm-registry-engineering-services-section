import assert from "node:assert/strict";
import test from "node:test";

import { auditOwnerNamespaceDebt } from "../src/owner-namespace-debt.mjs";

const root = "/workspace/services";
const row = (path, manifest) => ({ path: `${root}/${path}/package.json`, dir: `${root}/${path}`, manifest });

test("owner namespace debt is read from package location and the live dependency graph", async () => {
  const rows = [
    row("engineering-services-section/provider", { name: "@561-group/provider", version: "1.0.0" }),
    row("engineering-services-section/consumer", { name: "@red-cup-engineering/consumer", version: "1.0.0", dependencies: { "@561-group/provider": "1.0.0" } }),
    row("science-services-section/term", { name: "@lenticule-science/term", version: "1.0.0" }),
  ];
  const report = await auditOwnerNamespaceDebt(root, { scan: async () => rows });
  assert.equal(report.summary.violations, 1);
  assert.equal(report.summary.dependencyAssertionsToCurrentIdentities, 1);
  assert.deepEqual(report.findings[0], {
    section: "engineering",
    path: "engineering-services-section/provider/package.json",
    currentName: "@561-group/provider",
    currentScope: "@561-group",
    proposedName: "@red-cup-engineering/provider",
    version: "1.0.0",
    consumers: [{ consumer: "@red-cup-engineering/consumer", field: "dependencies", specification: "1.0.0" }],
    proposedIdentitySites: [],
    migrationClass: "coupled",
    blockers: ["active manifests still consume the current identity"],
  });
});

test("a target collision is explicit and output ordering is deterministic", async () => {
  const rows = [
    row("science-services-section/old", { name: "@red-cup-engineering/agent-organization-engine", version: "1.0.0" }),
    row("science-services-section/current", { name: "@lenticule-science/agent-organization-engine", version: "2.0.0" }),
    row("operations-services-section/zeta", { name: "zeta", version: "1.0.0" }),
  ];
  const report = await auditOwnerNamespaceDebt(root, { scan: async () => rows });
  assert.deepEqual(report.findings.map(({ section, currentName }) => [section, currentName]), [
    ["operations", "zeta"],
    ["science", "@red-cup-engineering/agent-organization-engine"],
  ]);
  assert.deepEqual(report.findings[1].proposedIdentitySites, ["science-services-section/current/package.json"]);
  assert.deepEqual(report.findings[1].blockers, ["proposed identity already exists"]);
});
