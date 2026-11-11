#!/usr/bin/env node
import { deriveReplicatedPackageCopies } from "../src/replicated-package-copies.mjs";
import { argument, requiredArgument } from "@red-cup-engineering/javascript-node-services-section/argv";

const root = requiredArgument("--root");
const format = argument("--format") ?? "summary";
const report = await deriveReplicatedPackageCopies({ root });

if (format === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (format === "summary") {
  const topGroupsByIdenticalExtraBytes = report.groups
    .flatMap((group) =>
      group.identicalSets.map((set) => {
        const bytes = group.copies.find((copy) => copy.dir === set[0]).bytes;
        return { name: group.name, setSize: set.length, bytesPerCopy: bytes, extraBytes: (set.length - 1) * bytes };
      }),
    )
    .sort((a, b) => b.extraBytes - a.extraBytes)
    .slice(0, 10);

  process.stdout.write(
    `${JSON.stringify(
      {
        kind: report.kind,
        root,
        totals: report.totals,
        topGroupsByIdenticalExtraBytes,
      },
      null,
      2,
    )}\n`,
  );
} else {
  throw new Error(`unknown --format: ${format}`);
}
