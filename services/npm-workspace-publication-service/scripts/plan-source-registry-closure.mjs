#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { planSourceRegistryClosure } from "../src/source-registry-closure.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("expected explicit input selection JSON and output plan JSON");
const selection = JSON.parse(await readFile(input, "utf8"));
const plan = await planSourceRegistryClosure(selection);
await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`);
console.log(JSON.stringify({ complete: plan.complete, consumers: plan.consumers, packages: plan.packages.length, providers: plan.packages.filter(p => p.publish).length, missingProviders: plan.missingProviders, missingEdges: plan.missingEdges, missingTargets: plan.packages.filter(p => p.missingTargets.length).map(p => ({ name: p.name, targets: p.missingTargets })), policyFindings: plan.packages.filter(p => p.violations.length).map(p => ({ name: p.name, violations: p.violations })) }));
