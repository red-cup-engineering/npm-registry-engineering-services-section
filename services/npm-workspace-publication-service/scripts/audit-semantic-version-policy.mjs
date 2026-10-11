#!/usr/bin/env node
import { auditSemanticVersionPolicy, summarizeSemanticVersionPolicyAudit } from "../src/semantic-version-audit.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const options = (name) => args.flatMap((argument, index) => argument === name && args[index + 1] !== undefined ? [args[index + 1]] : []);
const root = option("--root", process.cwd());
const names = new Set(options("--package"));
const prefix = option("--filter", null);
if (names.size > 0 && prefix !== null) throw new Error("--package and --filter are mutually exclusive");

if (args.includes("--help")) {
  process.stderr.write("usage: audit-semantic-version-policy [--root <dir>] [--package <name> ... | --filter <name-prefix>] [--summary]\n");
  process.exit(0);
}

const audit = await auditSemanticVersionPolicy(root, { names: [...names], prefix });
const output = args.includes("--summary") ? summarizeSemanticVersionPolicyAudit(audit) : audit;
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exit(audit.findings.length === 0 ? 0 : 1);
