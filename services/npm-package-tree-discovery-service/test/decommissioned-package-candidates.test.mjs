import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DECOMMISSIONED_PACKAGE_KEYWORD, discoverDecommissionedPackages } from "../src/decommissioned-package-candidates.mjs";

async function manifest(directory, body) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify(body)}\n`);
}

test("discovers every package explicitly marked decommissioned, including legacy carriers", async () => {
  const root = await mkdtemp(join(tmpdir(), "decommissioned-packages-"));
  try {
    await manifest(join(root, "live"), { name: "@example/live", version: "1.0.0", keywords: ["active"] });
    await manifest(join(root, "lib", "legacy", "retired"), { name: "@example/retired", version: "2.0.0", keywords: [DECOMMISSIONED_PACKAGE_KEYWORD] });
    await manifest(join(root, "nameless"), { keywords: [DECOMMISSIONED_PACKAGE_KEYWORD] });
    await manifest(join(root, "node_modules", "ignored"), { name: "@example/ignored", keywords: [DECOMMISSIONED_PACKAGE_KEYWORD] });

    const report = await discoverDecommissionedPackages({ root });

    assert.equal(report.kind, "npm.decommissioned-package-candidates");
    assert.equal(report.keyword, DECOMMISSIONED_PACKAGE_KEYWORD);
    assert.deepEqual(report.candidates.map(({ name }) => name), ["@example/retired", null]);
    assert.equal(report.candidates[1].version, null);
    assert.ok(report.candidates[0].directory.includes("/lib/legacy/"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an empty qualifying keyword", async () => {
  await assert.rejects(() => discoverDecommissionedPackages({ root: ".", keyword: "" }), TypeError);
});
