#!/usr/bin/env node
import { purgeIdenticalPackageReplicas } from "../src/replicated-package-copies.mjs";
import { requiredArgument } from "@red-cup-engineering/javascript-node-services-section/argv";

const root = requiredArgument("--root");
const apply = process.argv.includes("--apply");
const plan = await purgeIdenticalPackageReplicas({ root, apply });

process.stdout.write(
  `${JSON.stringify(
    {
      root,
      applied: apply,
      totals: {
        deleted: plan.deleted.length,
        deletedBytes: plan.deleted.reduce((sum, row) => sum + row.bytes, 0),
        kept: plan.kept.length,
        skipped: plan.skipped.length,
      },
      plan,
    },
    null,
    2,
  )}\n`,
);

if (plan.skipped.length > 0) process.exitCode = 2;
