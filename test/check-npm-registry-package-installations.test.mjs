import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkNpmRegistryPackageInstallations } from "../scripts/check-npm-registry-package-installations.mjs";

test("returns one explicit installation defect per failed selected release", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-installation-check-test-"));
  try {
    const registryReceiptPath = join(root, "registry.json");
    const npmConfigPath = join(root, "npmrc");
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages: [{ name: "@customer/example", version: "1.0.0" }] }));
    await writeFile(npmConfigPath, "");
    const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1, registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 };
    const receipt = await checkNpmRegistryPackageInstallations(request, { temporaryParent: root, async execute() { throw Object.assign(new Error("expected failure"), { stderr: "registry unavailable" }); } });
    assert.equal(receipt.type, "NpmRegistryPackageInstallationsCheckReceipt");
    assert.equal(receipt.conformant, false);
    assert.equal(receipt.reads.length, 1);
    assert.equal(receipt.reads[0].installed, false);
    assert.equal(receipt.defects[0].law, "registry-package-installation");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses inexact requests and missing selectors before installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-installation-check-test-"));
  try {
    const registryReceiptPath = join(root, "registry.json");
    const npmConfigPath = join(root, "npmrc");
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages: [{ name: "@customer/example", version: "1.0.0" }] }));
    await writeFile(npmConfigPath, "");
    const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1, registryReceiptPath, npmConfigPath, selections: ["@customer/absent"], concurrency: 1 };
    await assert.rejects(() => checkNpmRegistryPackageInstallations(request), /absent/);
    await assert.rejects(() => checkNpmRegistryPackageInstallations({ ...request, extra: true }), /exactly/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a returned spawn error is an installation refusal even with zero status", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-installation-spawn-test-"));
  try {
    const registryReceiptPath = join(root, "registry.json");
    const npmConfigPath = join(root, "npmrc");
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages: [{ name: "@customer/example", version: "1.0.0" }] }));
    await writeFile(npmConfigPath, "");
    const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1, registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 };
    const receipt = await checkNpmRegistryPackageInstallations(request, { temporaryParent: root, async execute() { return { status: 0, error: Object.assign(new Error("spawn blocked"), { code: "EPERM" }) }; } });
    assert.equal(receipt.conformant, false);
    assert.equal(receipt.reads[0].installed, false);
    assert.equal(receipt.defects[0].spawnError, "spawn blocked");
    assert.equal(receipt.defects[0].code, "EPERM");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a successful npm process cannot approve the wrong installed version", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-installation-identity-test-"));
  try {
    const registryReceiptPath = join(root, "registry.json");
    const npmConfigPath = join(root, "npmrc");
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages: [{ name: "@customer/example", version: "2.0.0" }] }));
    await writeFile(npmConfigPath, "");
    const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1, registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 };
    const receipt = await checkNpmRegistryPackageInstallations(request, { temporaryParent: root, async execute(command, args) {
      const project = args[args.indexOf("--prefix") + 1];
      const installed = join(project, "node_modules/@customer/example");
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, "package.json"), JSON.stringify({ name: "@customer/example", version: "1.0.0", type: "module", exports: "./index.mjs" }));
      await writeFile(join(installed, "index.mjs"), "export const value = 1;");
      return { stdout: "", stderr: "" };
    } });
    assert.equal(receipt.conformant, false);
    assert.equal(receipt.reads[0].inspection.resolution.packageVersion, "1.0.0");
    assert.ok(receipt.defects.some((defect) => defect.law === "installed-identity"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unavailable release and malformed installation do not abort independent entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-installation-batch-test-"));
  try {
    const registryReceiptPath = join(root, "registry.json");
    const npmConfigPath = join(root, "npmrc");
    const packages = ["absent", "corrupt", "exact"].map((leaf) => ({ name: "@customer/" + leaf, version: "1.0.0" }));
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages }));
    await writeFile(npmConfigPath, "");
    const receipt = await checkNpmRegistryPackageInstallations({ type: "NpmRegistryPackageInstallationsCheckRequest", version: 1, registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 }, {
      temporaryParent: root,
      async execute(command, args) {
        const name = args.at(-1).slice(0, args.at(-1).lastIndexOf("@"));
        if (name.endsWith("/absent")) throw Object.assign(new Error("version unavailable"), { code: "ETARGET" });
        const project = args[args.indexOf("--prefix") + 1];
        const installed = join(project, "node_modules", ...name.split("/"));
        await mkdir(installed, { recursive: true });
        await writeFile(join(installed, "package.json"), name.endsWith("/corrupt") ? "{" : JSON.stringify({ name, version: "1.0.0", type: "module", exports: { "./operation": "./index.mjs" } }));
        await writeFile(join(installed, "index.mjs"), "export const value = 1;");
        return { stdout: "", stderr: "" };
      },
    });
    const byName = new Map(receipt.reads.map((read) => [read.name, read]));
    assert.equal(receipt.reads.length, 3);
    assert.equal(byName.get("@customer/absent").installed, false);
    assert.ok(byName.get("@customer/corrupt").defects.length);
    assert.deepEqual(byName.get("@customer/exact").defects, []);
    assert.equal(byName.get("@customer/exact").inspection.resolution.packageVersion, "1.0.0");
  } finally { await rm(root, { recursive: true, force: true }); }
});
