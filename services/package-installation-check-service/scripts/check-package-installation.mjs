#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { checkPackageInstallations } from "../src/check-package-installation.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("package installation assay interrupted"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
  const packageNames = process.argv.filter((value, index) => process.argv[index - 1] === "--package");
  const concurrency = option("--concurrency");
  const receipt = await checkPackageInstallations({
    registryReceiptPath: option("--receipt"),
    npmConfigPath: option("--npmrc"),
    packageNames,
    concurrency: concurrency === undefined ? undefined : Number.parseInt(concurrency, 10),
    signal: cancellation.signal,
  });
  const output = option("--output");
  if (output) await writeFile(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ conformant: receipt.conformant, packages: receipt.packages, defects: receipt.defects.length, output: output ? resolve(output) : undefined }, null, 2)}\n`);
} catch (error) {
  const output = option("--output");
  if (output && error.receipt) await writeFile(resolve(output), `${JSON.stringify(error.receipt, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(error.receipt ? { conformant: false, packages: error.receipt.packages, defects: error.receipt.defects, output: output ? resolve(output) : undefined } : { error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
