import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadConfiguredNpmRegistryTarball, readConfiguredNpmRegistryPackageVersion } from "../src/registry.mjs";

const REGISTRY = "https://registry.example.test/";

test("configured npm transport reads exact metadata without parsing credential configuration", async () => {
  const calls = [];
  const observation = await readConfiguredNpmRegistryPackageVersion(REGISTRY, "@test/provider", "1.2.3", {
    npmEnvironment: { NPM_CONFIG_CACHE: "/tmp/verified-npm-cache" },
    execFileImpl: async (command, arguments_, options) => {
      calls.push({ command, arguments_, options });
      return { stdout: JSON.stringify({ name: "@test/provider", version: "1.2.3", dist: { integrity: "sha512-example" } }) };
    },
  });
  assert.equal(observation.found, true);
  assert.equal(observation.manifest.version, "1.2.3");
  assert.deepEqual(calls.map(({ command, arguments_ }) => [command, arguments_]), [["npm", ["view", "@test/provider@1.2.3", "--json", "--fetch-retries=0", "--fetch-timeout=5000", "--registry", REGISTRY]]]);
  assert.equal(calls[0].options.env.NPM_CONFIG_CACHE, "/tmp/verified-npm-cache");
});

test("configured npm transport distinguishes authorization failure from absent version", async () => {
  const authorization = await readConfiguredNpmRegistryPackageVersion(REGISTRY, "@test/provider", "1.2.3", {
    execFileImpl: async () => { throw Object.assign(new Error("npm failed"), { stderr: "npm error code E401\nnpm error authorization required" }); },
  });
  assert.deepEqual(authorization, { found: false, reachable: true, authorizationFailed: true, manifest: null });
  const absent = await readConfiguredNpmRegistryPackageVersion(REGISTRY, "@test/provider", "1.2.3", {
    execFileImpl: async () => { throw Object.assign(new Error("npm failed"), { stderr: "npm error code E404\nnpm error 404 Not Found" }); },
  });
  assert.deepEqual(absent, { found: false, reachable: true, manifest: null });
});

test("configured npm transport supports an explicit token without writing its bytes", async () => {
  await readConfiguredNpmRegistryPackageVersion(REGISTRY, "@test/provider", "1.2.3", {
    npmEnvironment: { NODE_AUTH_TOKEN: "fixture-token" },
    execFileImpl: async (_command, _arguments, options) => {
      const npmrc = await readFile(options.env.NPM_CONFIG_USERCONFIG, "utf8");
      assert.match(npmrc, /_authToken=\$\{NODE_AUTH_TOKEN\}/u);
      assert.doesNotMatch(npmrc, /fixture-token/u);
      return { stdout: JSON.stringify({ name: "@test/provider", version: "1.2.3" }) };
    },
  });
});

test("configured npm transport retains only a tarball matching advertised integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "configured-npm-pack-"));
  const bytes = Buffer.from("configured npm registry artifact");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const destination = join(root, "tarballs", "provider.tgz");
  try {
    await downloadConfiguredNpmRegistryTarball({
      registry: REGISTRY,
      name: "@test/provider",
      version: "1.2.3",
      integrity,
      destination,
      npmEnvironment: { NPM_CONFIG_CACHE: join(root, "cache") },
      execFileImpl: async (command, arguments_, options) => {
        assert.equal(command, "npm");
        assert.deepEqual(arguments_, ["pack", "@test/provider@1.2.3", "--json", "--ignore-scripts", "--fetch-retries=0", "--fetch-timeout=5000", "--registry", REGISTRY]);
        assert.equal(options.env.NPM_CONFIG_CACHE, join(root, "cache"));
        await writeFile(join(options.cwd, "provider-1.2.3.tgz"), bytes);
        return { stdout: JSON.stringify([{ name: "@test/provider", version: "1.2.3", filename: "provider-1.2.3.tgz" }]) };
      },
    });
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured npm transport reuses a matching immutable tarball without packing", async () => {
  const root = await mkdtemp(join(tmpdir(), "configured-npm-reuse-"));
  const bytes = Buffer.from("already admitted immutable artifact");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const destination = join(root, "tarballs", "provider.tgz");
  let calls = 0;
  try {
    await mkdir(join(root, "tarballs"));
    await writeFile(destination, bytes);
    await downloadConfiguredNpmRegistryTarball({
      registry: REGISTRY,
      name: "@test/provider",
      version: "1.2.3",
      integrity,
      destination,
      execFileImpl: async () => {
        calls += 1;
        throw new Error("matching artifact must not pack");
      },
    });
    assert.equal(calls, 0);
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured npm transport refuses conflicting immutable tarball without packing", async () => {
  const root = await mkdtemp(join(tmpdir(), "configured-npm-conflict-"));
  const destination = join(root, "tarballs", "provider.tgz");
  const integrity = `sha512-${createHash("sha512").update("expected artifact").digest("base64")}`;
  let calls = 0;
  try {
    await mkdir(join(root, "tarballs"));
    await writeFile(destination, "conflicting artifact");
    await assert.rejects(
      downloadConfiguredNpmRegistryTarball({
        registry: REGISTRY,
        name: "@test/provider",
        version: "1.2.3",
        integrity,
        destination,
        execFileImpl: async () => {
          calls += 1;
          throw new Error("conflicting artifact must not pack");
        },
      }),
      /existing registry artifact @test\/provider@1\.2\.3 has conflicting bytes/u,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
