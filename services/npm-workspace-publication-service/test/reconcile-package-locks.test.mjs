import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcilePackageLocks } from "../src/reconcile-package-locks.mjs";

const REGISTRY = "https://registry.example.test/npm/";

function generatedLock(manifest) {
  return {
    name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: {
      "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies },
      "node_modules/dep": { version: "1.0.0", resolved: `${REGISTRY}dep/-/dep-1.0.0.tgz`, integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" },
    },
  };
}

async function fixture(root, names = ["one", "two"]) {
  const claims = [];
  for (const id of names) {
    const path = join("packages", id), directory = join(root, path);
    const manifest = { name: `@test/${id}`, version: "1.0.0", type: "module", dependencies: { dep: "1.0.0" } };
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(directory, "index.mjs"), "export {};\n");
    await writeFile(join(directory, "package-lock.json"), `${JSON.stringify({ ...generatedLock(manifest), packages: { ...generatedLock(manifest).packages, "node_modules/dep": { ...generatedLock(manifest).packages["node_modules/dep"], version: "0.9.0" } } })}\n`);
    claims.push({ id, path });
  }
  return claims;
}

function fakeNpm({ failId = null, driftSource = null } = {}) {
  return async (_command, args, options) => {
    if (args[0] === "--version") return { stdout: "11.17.0\n", stderr: "" };
    const id = options.cwd.split("/").at(-1);
    if (args[0] === "install") {
      if (failId === id) throw new Error(`${id} refused`);
      const manifest = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
      const lock = generatedLock(manifest);
      await writeFile(join(options.cwd, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "ci" && driftSource && id === "one") await writeFile(driftSource, "changed during reconciliation\n");
    return { stdout: "", stderr: "" };
  };
}

async function reconcile(root, roots, commandRunner, extra = {}) {
  return reconcilePackageLocks({ workspaceRoot: root, roots, registry: REGISTRY, token: "ephemeral-test-token", expectedNodeVersion: process.version, expectedNpmVersion: "11.17.0", commandRunner, temporaryBase: "/tmp", ...extra });
}

test("reconciles stale direct selections only after generation and the all-roots barrier", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-locks-green-")); t.after(() => rm(root, { recursive: true, force: true }));
  const roots = await fixture(root);
  const first = await reconcile(root, roots, fakeNpm());
  const bytes = await Promise.all(roots.map(({ path }) => readFile(join(root, path, "package-lock.json"), "utf8")));
  assert.equal(bytes.every((value) => JSON.parse(value).packages["node_modules/dep"].version === "1.0.0"), true);
  const second = await reconcile(root, roots, fakeNpm());
  assert.deepEqual(second.locks, first.locks);
  assert.deepEqual(await Promise.all(roots.map(({ path }) => readFile(join(root, path, "package-lock.json"), "utf8"))), bytes);
});

test("one failed root causes zero repository writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-locks-fail-")); t.after(() => rm(root, { recursive: true, force: true }));
  const roots = await fixture(root), before = await Promise.all(roots.map(({ path }) => readFile(join(root, path, "package-lock.json"))));
  await assert.rejects(reconcile(root, roots, fakeNpm({ failId: "two" })), /two refused/u);
  assert.deepEqual(await Promise.all(roots.map(({ path }) => readFile(join(root, path, "package-lock.json")))), before);
});

test("source drift before the write barrier causes zero repository writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-locks-drift-")); t.after(() => rm(root, { recursive: true, force: true }));
  const roots = await fixture(root), target = join(root, roots[0].path, "index.mjs");
  const before = await Promise.all(roots.map(({ path }) => readFile(join(root, path, "package-lock.json"))));
  await assert.rejects(reconcile(root, roots, fakeNpm({ driftSource: target })), /source inputs changed before lock write/u);
  assert.deepEqual(await Promise.all(roots.map(({ path }) => readFile(join(root, path, "package-lock.json")))), before);
});

test("canonicalizes direct and nested scoped package tarballs from their final package segment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-locks-nested-")); t.after(() => rm(root, { recursive: true, force: true }));
  const roots = await fixture(root, ["one"]), installationRegistry = "http://127.0.0.1:4873/";
  const commandRunner = async (_command, args, options) => {
    if (args[0] === "--version") return { stdout: "11.17.0\n", stderr: "" };
    if (args[0] === "install") {
      const manifest = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
      const lock = generatedLock(manifest);
      lock.packages["node_modules/parent"] = {
        version: "2.0.0",
        resolved: `${installationRegistry}parent/-/parent-2.0.0.tgz`,
        integrity: "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==",
        dependencies: { "@scope/child": "1.0.0" },
      };
      lock.packages["node_modules/parent/node_modules/@scope/child"] = {
        version: "1.0.0",
        resolved: `${installationRegistry}@scope/child/-/child-1.0.0.tgz`,
        integrity: "sha512-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC==",
      };
      lock.packages["node_modules/@logtape/logtape"] = {
        version: "0.8.0",
        resolved: `${installationRegistry}@logtape/logtape/-/logtape-0.8.0.tgz`,
        integrity: "sha512-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD==",
      };
      lock.packages["node_modules/dep"].resolved = `${installationRegistry}dep/-/dep-1.0.0.tgz`;
      await writeFile(join(options.cwd, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    }
    if (args[0] === "ci") {
      const lock = JSON.parse(await readFile(join(options.cwd, "package-lock.json"), "utf8"));
      assert.equal(lock.packages["node_modules/@logtape/logtape"].resolved.startsWith(installationRegistry), true);
    }
    return { stdout: "", stderr: "" };
  };
  await reconcile(root, roots, commandRunner, { installationRegistry });
  const lock = JSON.parse(await readFile(join(root, roots[0].path, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/@logtape/logtape"].resolved, `${REGISTRY}@logtape/logtape/-/logtape-0.8.0.tgz`);
  assert.equal(lock.packages["node_modules/parent/node_modules/@scope/child"].resolved, `${REGISTRY}@scope/child/-/child-1.0.0.tgz`);
});

test("reconciliation lets npm resolve configured authentication when no token is supplied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-locks-public-")); t.after(() => rm(root, { recursive: true, force: true }));
  const roots = await fixture(root, ["one"]), npm = fakeNpm();
  const commandRunner = async (command, args, options) => {
    if (options?.env) assert.equal(options.env.NPM_CONFIG_USERCONFIG, process.env.NPM_CONFIG_USERCONFIG);
    return npm(command, args, options);
  };
  await reconcile(root, roots, commandRunner, { token: undefined });
});
