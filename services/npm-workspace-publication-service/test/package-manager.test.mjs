import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPackageManager, hasPackageManagerLockfile, packageManagerInstallCommand } from "../src/package-manager.mjs";

test("detectPackageManager reads a declared packageManager field first", () => {
  assert.equal(detectPackageManager({ manifest: { packageManager: "pnpm@9.1.0" }, presentFiles: ["package-lock.json"] }), "pnpm");
});

test("detectPackageManager falls back to the present lockfile, pnpm before yarn before npm", () => {
  assert.equal(detectPackageManager({ manifest: {}, presentFiles: ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"] }), "pnpm");
  assert.equal(detectPackageManager({ manifest: {}, presentFiles: ["yarn.lock"] }), "yarn");
  assert.equal(detectPackageManager({ manifest: {}, presentFiles: ["package-lock.json"] }), "npm");
});

test("detectPackageManager defaults to npm with no manifest field and no lockfile", () => {
  assert.equal(detectPackageManager({ manifest: {}, presentFiles: [] }), "npm");
  assert.equal(detectPackageManager({ manifest: undefined, presentFiles: [] }), "npm");
});

test("hasPackageManagerLockfile only accepts the selected manager's lock", () => {
  assert.equal(hasPackageManagerLockfile("npm", ["package-lock.json", "pnpm-lock.yaml"]), true);
  assert.equal(hasPackageManagerLockfile("pnpm", ["package-lock.json"]), false);
});

test("packageManagerInstallCommand verifies each committed lock without deleting it", () => {
  const result = packageManagerInstallCommand("npm", "https://registry.561.group", "verify");
  assert.equal(result.command, "npm");
  assert.deepEqual(result.arguments, ["ci", "--no-audit", "--no-fund", "--registry", "https://registry.561.group"]);
  const pnpm = packageManagerInstallCommand("pnpm", "https://registry.561.group", "verify");
  assert.equal(pnpm.command, "pnpm");
  assert.deepEqual(pnpm.arguments, ["install", "--frozen-lockfile", "--registry", "https://registry.561.group"]);
  const yarn = packageManagerInstallCommand("yarn", "https://registry.561.group", "verify");
  assert.equal(yarn.command, "yarn");
  assert.deepEqual(yarn.arguments, ["install", "--frozen-lockfile", "--registry", "https://registry.561.group"]);
});

test("packageManagerInstallCommand updates the lock with the owning manager after a manifest pin changes", () => {
  assert.deepEqual(packageManagerInstallCommand("npm", "https://registry.561.group", "update-lock").arguments, ["install", "--no-audit", "--no-fund", "--registry", "https://registry.561.group"]);
  assert.deepEqual(packageManagerInstallCommand("pnpm", "https://registry.561.group", "update-lock").arguments, ["install", "--no-frozen-lockfile", "--registry", "https://registry.561.group"]);
  assert.deepEqual(packageManagerInstallCommand("yarn", "https://registry.561.group", "update-lock").arguments, ["install", "--registry", "https://registry.561.group"]);
});

test("packageManagerInstallCommand rejects unknown managers and modes", () => {
  assert.throws(() => packageManagerInstallCommand("bun", "https://registry.561.group", "verify"), /unknown manager/u);
  assert.throws(() => packageManagerInstallCommand("npm", "https://registry.561.group", "guess"), /unknown install mode/u);
});

test("packageManagerInstallCommand can prefer the manager's own standing cache as a registry fallback", () => {
  assert.deepEqual(packageManagerInstallCommand("npm", "https://registry.561.group", "update-lock", { preferOffline: true }).arguments, ["install", "--no-audit", "--no-fund", "--registry", "https://registry.561.group", "--prefer-offline"]);
  assert.deepEqual(packageManagerInstallCommand("pnpm", "https://registry.561.group", "update-lock", { preferOffline: true }).arguments, ["install", "--no-frozen-lockfile", "--registry", "https://registry.561.group", "--config.prefer-offline=true"]);
  assert.throws(() => packageManagerInstallCommand("npm", "https://registry.561.group", "update-lock", { preferOffline: true, cacheRoot: "/tmp/x" }), /cannot combine/u);
});
