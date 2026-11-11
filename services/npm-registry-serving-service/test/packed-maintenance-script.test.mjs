import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readTarball } from "../src/tarball-reader.mjs";

const run = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));

/** Direct, already received suppliers keep their own original transitive resolution. */
function installedSuppliers(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  return Object.entries(manifest.dependencies ?? {}).map(([name, version]) => {
    const lookup = createRequire(join(directory, "package.json")).resolve.paths(name) ?? [];
    const located = lookup.map(modules => join(modules, name)).find(candidate => existsSync(join(candidate, "package.json")));
    if (located === undefined) throw new Error(`${name} of ${manifest.name} is not received`);
    const root = realpathSync(located), actual = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (actual.name !== name || actual.version !== version) throw new Error(`${name}@${version} differs from its received supplier`);
    return { name, root };
  });
}

test("installed package retains the registry-uplink-prune job's script", { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "registry-packed-maintenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const consumer = join(root, "consumer"), artifacts = join(root, "artifacts");
  await mkdir(consumer); await mkdir(artifacts);
  const userconfig = join(root, "npmrc"), globalconfig = join(root, "global-npmrc");
  await writeFile(userconfig, ""); await writeFile(globalconfig, "");
  const env = { ...process.env, npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_cache: join(root, "npm-cache") };
  const pack = async (directory) => {
    const { stdout } = await run("npm", ["pack", directory, "--json", "--ignore-scripts", "--pack-destination", artifacts], { cwd: root, env, signal: t.signal });
    return join(artifacts, JSON.parse(stdout)[0].filename);
  };
  // Pack only the registry package; link existing exact dependency contexts.
  const dependencies = installedSuppliers(source);
  const artifact = await pack(source);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true }));
  const packageDirectory = join(consumer, "node_modules", "@red-cup-engineering", "npm-registry-serving-service");
  // Decode the package with the original bounded npm archive codec. No package
  // manager installs or materializes another copy of any received dependency.
  for (const [name, bytes] of readTarball(await readFile(artifact))) {
    const file = join(packageDirectory, name);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
  }
  for (const supplier of dependencies) {
    const file = join(packageDirectory, "node_modules", supplier.name);
    await mkdir(dirname(file), { recursive: true }); await symlink(supplier.root, file, "dir");
  }
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  for (const entry of manifest.receivingTests) {
    assert.deepEqual(await readFile(join(packageDirectory, entry)), await readFile(join(source, entry)), `the installed package must retain enrolled receiving test ${entry}`);
  }
  const installed = join(packageDirectory, "scripts", "prune-uplink-cache.mjs");
  assert.deepEqual(await readFile(installed), await readFile(join(source, "scripts", "prune-uplink-cache.mjs")), "the installed job entry must retain the authored script bytes");
  assert.deepEqual(installedSuppliers(packageDirectory), dependencies, "the installed package must retain the exact received supplier contexts");
  await run(process.execPath, ["--input-type=module", "--eval",
    'const codec = await import("@red-cup-engineering/npm-registry-serving-service/prepared-publication"); if (typeof codec.admittedPublication !== "function") throw Error("packed npm codec is not loadable");'],
    { cwd: consumer, env, signal: t.signal });
  // Parse only. Never import or execute pruning, even against fixture storage.
  await run(process.execPath, ["--check", installed], { cwd: consumer, env, signal: t.signal });
  // Verify bin links are not materialized as files but manifest.bin is preserved and targets are valid.
  const sourceManifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  assert.deepEqual(manifest.bin, sourceManifest.bin, "the installed manifest.bin must equal the authored manifest.bin");
  for (const [name, target] of Object.entries(sourceManifest.bin ?? {})) {
    const binPath = join(packageDirectory, target);
    assert.ok(existsSync(binPath), `the installed bin target ${name} must exist`);
    assert.deepEqual(await readFile(binPath), await readFile(join(source, target)), `the installed bin target ${name} must retain the authored bytes`);
    await run(process.execPath, ["--check", binPath], { cwd: consumer, env, signal: t.signal });
  }
});
