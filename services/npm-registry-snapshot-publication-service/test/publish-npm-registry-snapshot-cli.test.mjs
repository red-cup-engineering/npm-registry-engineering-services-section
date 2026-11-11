import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { publishNpmRegistrySnapshot } from "../src/publish-npm-registry-snapshot.mjs";
import { publishNpmRegistrySnapshot as publishNpmRegistrySnapshotViaScript } from "../scripts/publish-npm-registry-snapshot.mjs";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/publish-npm-registry-snapshot.mjs");

test("the scripts/ CLI entrypoint re-exports the same operation as src/, without reimplementing it", () => {
  assert.equal(publishNpmRegistrySnapshotViaScript, publishNpmRegistrySnapshot);
});

test("CLI requires --package, --host, --snapshot, and --registry-url", () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: publish-npm-registry-snapshot/u);
});

test("CLI prints usage and exits cleanly on --help", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: publish-npm-registry-snapshot/u);
});
