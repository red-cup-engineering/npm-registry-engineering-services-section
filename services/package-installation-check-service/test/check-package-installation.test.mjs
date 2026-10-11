import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectInstalledPackage, selectRegistryPackages } from "../src/check-package-installation.mjs";

test("accepts complete installed faces and internal relative imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-package-inspection-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "@customer/example", version: "1.0.0", exports: "./src/index.mjs", bin: { example: "src/cli.mjs" } })}\n`);
    await writeFile(join(root, "src/index.mjs"), "import './side-effect.mjs';\nexport { value } from './value.mjs';\n");
    await writeFile(join(root, "src/side-effect.mjs"), "export {};\n");
    await writeFile(join(root, "src/value.mjs"), "export const value = 1;\n");
    await writeFile(join(root, "src/cli.mjs"), "#!/usr/bin/env node\nconsole.log('ok');\n");
    const result = await inspectInstalledPackage({ packageRoot: root, expectedName: "@customer/example", expectedVersion: "1.0.0" });
    assert.deepEqual(result.defects, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses missing faces and imports escaping the carrier", async () => {
  const root = await mkdtemp(join(tmpdir(), "installed-package-refusal-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "@customer/broken", version: "1.0.0", exports: { ".": "./src/index.mjs", "./missing": "./src/missing.mjs" } })}\n`);
    await writeFile(join(root, "src/index.mjs"), "import './missing-side-effect.mjs';\nimport 'absent-dependency';\nexport { value } from '../../sibling.mjs';\n");
    const result = await inspectInstalledPackage({ packageRoot: root, expectedName: "@customer/broken", expectedVersion: "1.0.0" });
    assert.deepEqual(result.defects.map(({ law }) => law).sort(), ["installed-face-target", "relative-import-membrane", "relative-import-target", "runtime-dependency-declaration"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selects exact releases and refuses an ambiguous package name", () => {
  const packages = [
    { name: "@customer/example", version: "1.0.0" },
    { name: "@customer/example", version: "2.0.0" },
    { name: "@customer/other", version: "1.0.0" },
  ];
  assert.deepEqual(selectRegistryPackages(packages, ["@customer/example@2.0.0", "@customer/other"]), [packages[1], packages[2]]);
  assert.throws(() => selectRegistryPackages(packages, ["@customer/example"]), /version-ambiguous/u);
  assert.throws(() => selectRegistryPackages(packages, ["@customer/absent@1.0.0"]), /absent/u);
});
