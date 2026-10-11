import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/assay-carrier-module-graph.mjs");

async function fixture(manifest, files, assayRoot = "carrier") {
  const root = await mkdtemp(join(tmpdir(), "carrier-module-graph-"));
  const carrier = join(root, assayRoot);
  await mkdir(carrier, { recursive: true });
  await writeFile(join(carrier, "package.json"), `${JSON.stringify(manifest)}\n`);
  for (const [path, source] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source);
  }
  return { root, carrier, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function assay(carrier) {
  try {
    const { stdout } = await execute(process.execPath, ["--experimental-vm-modules", script, "--root", carrier, "--manifest", join(carrier, "package.json")]);
    return JSON.parse(stdout);
  } catch (error) {
    return JSON.parse(error.stdout);
  }
}

test("assay admits the static carrier closure and declared production bare imports", async () => {
  const value = await fixture({ type: "module", exports: "./src/index.mjs", dependencies: { dependency: "1.0.0" } }, {
    "carrier/src/index.mjs": 'import "dependency/subpath"; export { value } from "./value.mjs";\n',
    "carrier/src/value.mjs": "export const value = 1;\n",
  });
  try {
    const result = await assay(value.carrier);
    assert.equal(result.outcome, "carrier-module-graph-admitted");
    assert.equal(result.packedJavaScriptModules, 2);
    assert.equal(result.runtimeReachableModules, 2);
    assert.deepEqual(result.violations, []);
  } finally { await value.cleanup(); }
});

test("assay refuses a static relative import escaping the carrier", async () => {
  const value = await fixture({ type: "module", exports: "./index.mjs" }, {
    "carrier/index.mjs": 'export { secret } from "../repo-only.mjs";\n',
    "repo-only.mjs": "export const secret = true;\n",
  });
  try {
    const result = await assay(value.carrier);
    assert.deepEqual(result.violations, [{ kind: "unavailable-carrier-module", importer: "index.mjs", specifier: "../repo-only.mjs", reason: "outside-carrier" }]);
  } finally { await value.cleanup(); }
});

test("assay distinguishes undeclared and dev-only runtime imports", async () => {
  const value = await fixture({ type: "module", exports: "./index.mjs", devDependencies: { testing: "1.0.0" } }, {
    "carrier/index.mjs": 'import "testing"; import "missing/subpath";\n',
  });
  try {
    const result = await assay(value.carrier);
    assert.deepEqual(result.violations, [
      { kind: "undeclared-carrier-dependency", importer: "index.mjs", specifier: "missing/subpath", dependency: "missing" },
      { kind: "dev-only-runtime-dependency", importer: "index.mjs", specifier: "testing", dependency: "testing" },
    ]);
  } finally { await value.cleanup(); }
});

test("assay admits a package self-reference governed by the same exports map", async () => {
  const value = await fixture({ name: "@example/carrier", type: "module", exports: { ".": "./index.mjs", "./value": "./value.mjs" } }, {
    "carrier/index.mjs": 'export { value } from "./nested/consumer.mjs";\n',
    "carrier/nested/consumer.mjs": 'export { value } from "@example/carrier/value";\n',
    "carrier/value.mjs": "export const value = 1;\n",
  });
  try {
    const result = await assay(value.carrier);
    assert.deepEqual(result.violations, []);
    assert.equal(result.runtimeReachableModules, 3);
  } finally { await value.cleanup(); }
});

test("assay refuses an unexported package self-reference", async () => {
  const value = await fixture({ name: "@example/carrier", type: "module", exports: "./index.mjs" }, {
    "carrier/index.mjs": 'export { value } from "@example/carrier/not-exported";\n',
  });
  try {
    const result = await assay(value.carrier);
    assert.deepEqual(result.violations, [{ kind: "unexported-self-reference", importer: "index.mjs", specifier: "@example/carrier/not-exported" }]);
  } finally { await value.cleanup(); }
});

test("assay resolves package imports and literal CommonJS and dynamic requests", async () => {
  const value = await fixture({ type: "module", exports: "./index.mjs", imports: { "#value": "./value.cjs" } }, {
    "carrier/index.mjs": 'export const value = (await import("#value")).default;\n',
    "carrier/value.cjs": 'module.exports = require("./nested");\n',
    "carrier/nested.js": "module.exports = 1;\n",
  });
  try {
    const result = await assay(value.carrier);
    assert.deepEqual(result.violations, []);
    assert.equal(result.runtimeReachableModules, 3);
  } finally { await value.cleanup(); }
});

test("assay refuses computed requests in the runtime closure", async () => {
  const value = await fixture({ type: "module", exports: "./index.mjs" }, {
    "carrier/index.mjs": "export async function load(name) { return import(name); }\n",
  });
  try {
    const result = await assay(value.carrier);
    assert.deepEqual(result.violations, [{ kind: "computed-runtime-module-request", importer: "index.mjs", specifier: null, requestKind: "dynamic-import" }]);
  } finally { await value.cleanup(); }
});

test("a declared node script is part of the runtime carrier closure", async () => {
  const value = await fixture({ type: "module", scripts: { census: "node scripts/census.mjs" } }, {
    "carrier/scripts/census.mjs": 'import "../src/missing.mjs";\n',
  });
  try {
    const result = await assay(value.carrier);
    assert.deepEqual(result.violations, [{ kind: "unavailable-carrier-module", importer: "scripts/census.mjs", specifier: "../src/missing.mjs", reason: "absent" }]);
    assert.equal(result.runtimeReachableModules, 1);
  } finally { await value.cleanup(); }
});
