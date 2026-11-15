import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkNpmRegistryPackageInstallations } from "@red-cup-engineering/npm-registry-engineering-services-section/check-npm-registry-package-installations";

const registry = "https://registry.example.test/";
const artifactIntegrity = "sha512-" + Buffer.alloc(64, 2).toString("base64");
const row = (name, version) => ({ name, version, integrity: artifactIntegrity,
  tarball: registry + "tarballs/" + name.replace(/^@/u, "") + "-" + version + ".tgz" });
async function publishFixtureLock(project, name, binding) {
  await writeFile(join(project, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3, packages: { ["node_modules/" + name]: binding },
  }));
}

test("returns one explicit installation defect per failed selected release", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-installation-check-test-"));
  try {
    const registryReceiptPath = join(root, "registry.json");
    const npmConfigPath = join(root, "npmrc");
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages: [row("@customer/example", "1.0.0")] }));
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
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages: [row("@customer/example", "1.0.0")] }));
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
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages: [row("@customer/example", "1.0.0")] }));
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
    await writeFile(registryReceiptPath, JSON.stringify({ registry: "https://registry.example.test/", packages: [row("@customer/example", "2.0.0")] }));
    await writeFile(npmConfigPath, "");
    const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1, registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 };
    const receipt = await checkNpmRegistryPackageInstallations(request, { temporaryParent: root, async execute(command, args) {
      const project = args[args.indexOf("--prefix") + 1];
      const installed = join(project, "node_modules/@customer/example");
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, "package.json"), JSON.stringify({ name: "@customer/example", version: "1.0.0", type: "module", exports: "./index.mjs" }));
      await writeFile(join(installed, "index.mjs"), "export const value = 1;");
      await publishFixtureLock(project, "@customer/example", { version: "1.0.0", integrity: artifactIntegrity,
        resolved: row("@customer/example", "2.0.0").tarball });
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
    const packages = ["absent", "corrupt", "exact"].map((leaf) => row("@customer/" + leaf, "1.0.0"));
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
        await publishFixtureLock(project, name, { version: "1.0.0", integrity: artifactIntegrity, resolved: row(name, "1.0.0").tarball });
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

test("an exact installed version is not proof of the receipt's artifact", async t => {
  const root = await mkdtemp(join(tmpdir(), "registry-exact-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryReceiptPath = join(root, "registry.json"), npmConfigPath = join(root, "npmrc");
  const release = row("@customer/example", "1.0.0");
  await writeFile(registryReceiptPath, JSON.stringify({ registry, packages: [release] }));
  await writeFile(npmConfigPath, "");
  const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1,
    registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 };
  for (const [label, overrides, expected] of [
    ["exact", {}, []],
    ["wrong digest", { integrity: "sha512-" + Buffer.alloc(64, 3).toString("base64") }, ["integrity"]],
    ["wrong archive", { resolved: registry + "different.tgz" }, ["resolved"]],
    ["linked package", { link: true }, ["link"]],
    ["missing lock", null, ["package-lock"]],
  ]) {
    const result = await checkNpmRegistryPackageInstallations(request, {temporaryParent:root, execute: async (_, args) => {
      assert.ok(args.includes("--package-lock=true"));
      const project = args[args.indexOf("--prefix") + 1];
      const installed = join(project, "node_modules/@customer/example");
      await mkdir(installed, {recursive:true});
      await writeFile(join(installed,"package.json"), JSON.stringify({name:release.name,version:release.version, exports:"./index.mjs"}));
      await writeFile(join(installed,"index.mjs"), "export const value = 1;");
      if (overrides) await publishFixtureLock(project, release.name, {version:release.version, integrity:release.integrity, resolved:release.tarball, ...overrides});
      return {status:0};
    }});
    assert.equal(result.reads[0].installed, true);
    assert.equal(result.conformant, expected.length === 0, label);
    if (expected.length === 0) {
      assert.equal(result.reads[0].artifactBinding.integrity, release.integrity);
      assert.equal(result.reads[0].artifactBinding.tarball, release.tarball);
      assert.match(result.reads[0].artifactBinding.lockfileSha256, /^[a-f0-9]{64}$/u);
    } else assert.equal(result.reads[0].artifactBinding, null);
    assert.deepEqual(result.defects.filter(({law})=>law==="registry-installed-artifact").map(({field})=>field),expected,label);
  }
  await writeFile(registryReceiptPath, JSON.stringify({ registry, packages: [{ name: release.name, version: release.version }] }));
  let executed = false;
  const refused = await checkNpmRegistryPackageInstallations(request,{temporaryParent:root,execute:async()=>{executed=true;}});
  assert.equal(executed,false);
  assert.equal(refused.defects[0].law,"registry-release-artifact");
});

test("an empty registry receipt cannot certify a conformant installation assay", async t => {
  const root = await mkdtemp(join(tmpdir(), "registry-empty-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryReceiptPath = join(root, "registry.json");
  const npmConfigPath = join(root, "npmrc");
  await writeFile(registryReceiptPath, JSON.stringify({ registry, packages: [] }));
  await writeFile(npmConfigPath, "");
  const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1,
    registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 };
  const receipt = await checkNpmRegistryPackageInstallations(request, {
    temporaryParent: root,
    execute() { assert.fail("an empty assay must not execute npm"); },
  });
  assert.equal(receipt.conformant, false);
  assert.deepEqual(receipt.reads, []);
  assert.equal(receipt.defects[0].law, "registry-installation-selection");
});

test("an installation assay executes once for each exact release even when selectors overlap", async t => {
  const root = await mkdtemp(join(tmpdir(), "registry-overlap-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryReceiptPath = join(root, "registry.json");
  const npmConfigPath = join(root, "npmrc");
  await writeFile(registryReceiptPath, JSON.stringify({ registry, packages: [row("@customer/example", "1.0.0")] }));
  await writeFile(npmConfigPath, "");
  const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1,
    registryReceiptPath, npmConfigPath, selections: ["@customer/example", "@customer/example@1.0.0"], concurrency: 2 };
  let executions = 0;
  const receipt = await checkNpmRegistryPackageInstallations(request, {
    temporaryParent: root,
    execute() { executions += 1; throw Error("fixture transport refused"); },
  });
  assert.equal(executions, 1);
  assert.equal(receipt.reads.length, 1);
  assert.equal(receipt.conformant, false);
});

test("receipt registry addresses with credentials or URL parameters are refused before starting the assay", async t => {
  const root = await mkdtemp(join(tmpdir(), "registry-unsafe-endpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryReceiptPath = join(root, "registry.json");
  const npmConfigPath = join(root, "npmrc");
  await writeFile(npmConfigPath, "");
  const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1,
    registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 };
  let invoked = false;
  for (const invalid of ["https://example-user:fixture-marker@registry.example.test/",
    "https://registry.example.test/?fixture-marker=1", "https://registry.example.test/#fixture-marker",
    "https://registry.example.test/?", "https://registry.example.test/#"]) {
    await writeFile(registryReceiptPath, JSON.stringify({ registry: invalid, packages: [row("example", "1.0.0")] }));
    await assert.rejects(() => checkNpmRegistryPackageInstallations(request, {
      temporaryParent: root, execute() { invoked = true; throw Error("fixture transport"); },
    }), error => error instanceof TypeError && /credential-free/u.test(error.message) &&
      !error.message.includes("fixture-marker"));
  }
  assert.equal(invoked, false);
});

test("a tarball URL ending in an empty query or fragment cannot be an exact artifact locator", async t => {
  const root = await mkdtemp(join(tmpdir(), "registry-unsafe-carrier-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryReceiptPath = join(root, "registry.json");
  const npmConfigPath = join(root, "npmrc");
  await writeFile(npmConfigPath, "");
  const request = { type: "NpmRegistryPackageInstallationsCheckRequest", version: 1,
    registryReceiptPath, npmConfigPath, selections: [], concurrency: 1 };
  const selection = row("example", "1.0.0");
  let invoked = false;
  for (const delimiter of ["?", "#"]) {
    await writeFile(registryReceiptPath, JSON.stringify({ registry, packages: [
      { ...selection, tarball: selection.tarball + delimiter },
    ] }));
    const receipt = await checkNpmRegistryPackageInstallations(request, {
      temporaryParent: root, execute() { invoked = true; throw Error("fixture transport"); },
    });
    assert.equal(receipt.conformant, false);
    assert.equal(receipt.reads[0].defects[0].law, "registry-release-artifact");
  }
  assert.equal(invoked, false);
});
