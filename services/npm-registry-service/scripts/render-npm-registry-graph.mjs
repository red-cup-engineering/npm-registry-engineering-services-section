#!/usr/bin/env node
import { parseArgs } from "node:util";

import { deriveRegistryGraph, groupRegistryGraphDefects, renderRegistryGraphDot } from "@red-cup-engineering/npm-registry-graph-services-section";

const { values } = parseArgs({
  options: {
    registry: { type: "string" },
    package: { type: "string", multiple: true, default: [] },
    "internal-scope": { type: "string", multiple: true, default: [] },
    format: { type: "string", default: "summary" },
    tier: { type: "string" },
    "allow-defects": { type: "boolean", default: false },
  },
});

if (!values.registry) throw new Error("--registry is required");

const graph = await deriveRegistryGraph({
  ...(/^https?:\/\//u.test(values.registry) ? { registryUrl: values.registry } : { registryRoot: values.registry }),
  ...(values.package.length > 0 ? { packages: values.package } : {}),
  ...(values["internal-scope"].length > 0 ? { internalScopes: values["internal-scope"] } : {}),
});
const format = values.format;
const allowDefects = values["allow-defects"];
const defectGroups = groupRegistryGraphDefects(graph.defects);
if (format === "json") {
  process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
} else if (format === "dot") {
  process.stdout.write(renderRegistryGraphDot(graph, { tier: values.tier ?? "dependency" }));
} else if (format === "edges") {
  const tier = values.tier ?? "dependency";
  for (const edge of graph.tiers[tier]?.edges ?? []) {
    process.stdout.write(`${edge.from}\t${edge.relation}\t${edge.to}\n`);
  }
} else if (format === "summary") {
  process.stdout.write(`${JSON.stringify({
    type: graph.type,
    registry: graph.registry,
    receiptSha256: graph.receiptSha256,
    nodes: graph.nodes.length,
    dependencyEdges: graph.tiers.dependency.edges.length,
    history: graph.tiers.history,
    defects: graph.defects.length,
    defectGroups: defectGroups.map(({ consumers: _consumers, ...group }) => group),
  }, null, 2)}\n`);
} else {
  throw new Error(`unknown --format: ${format}`);
}
if (graph.defects.length > 0 && !allowDefects) {
  for (const group of defectGroups) {
    process.stderr.write(`registry graph defect group: ${group.kind} -> ${group.target} (${group.relation}); ${group.count} consumer(s)\n`);
  }
  process.exitCode = 1;
}
