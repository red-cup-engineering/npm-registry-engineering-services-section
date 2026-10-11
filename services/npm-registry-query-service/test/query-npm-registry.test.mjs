import assert from "node:assert/strict";
import { execFile } from "node:child_process";

import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { dependenciesOf, dependentsOf, interfacesOf, openNpmRegistryQuerySource, packageExists, searchPackages } from "../src/query-npm-registry.mjs";
import { createServer as createLoopbackServer } from "node:http";

/** A loopback fixture server over the platform HTTP runtime; the code under test is its client. */
const createHttpServer = ({ handle }) => createLoopbackServer(handle);

const execute = promisify(execFile);

async function fixtureRegistry() {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-query-fixture-"));
  await mkdir(join(root, "metadata"), { recursive: true });
  const packages = [
    { name: "@customer/gamma", version: "1.0.0", dependencies: { "@customer/beta": "^1.0.0" } },
    { name: "@customer/alpha", version: "2.0.0", dependencies: { "@customer/zeta": "2.0.0", "@customer/beta": "2.0.0" }, exports: { ".": "./src/index.mjs" }, bin: { alpha: "./scripts/alpha.mjs" }, scripts: { verify: "node --test" }, engines: { node: ">=22" }, os: ["linux"], cpu: ["x64"] },
    { name: "@customer/alpha", version: "1.0.0", dependencies: { "@customer/beta": "1.0.0" }, exports: "./src/index.mjs", bin: "./scripts/alpha.mjs" },
    { name: "@customer/beta", version: "1.0.0", dependencies: {} },
  ];
  const alphaVersions = Object.fromEntries(packages.filter((pkg) => pkg.name === "@customer/alpha").map((pkg) => [pkg.version, structuredClone(pkg)]));
  for (const pkg of packages.filter((candidate) => candidate.name !== "@customer/alpha")) {
    await writeFile(join(root, "metadata", `${encodeURIComponent(pkg.name)}.json`), JSON.stringify({ _id: pkg.name, name: pkg.name, "dist-tags": { latest: pkg.version }, versions: { [pkg.version]: { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies } } }));
  }
  await writeFile(join(root, "metadata", `${encodeURIComponent("@customer/alpha")}.json`), JSON.stringify({ _id: "@customer/alpha", name: "@customer/alpha", "dist-tags": { latest: "2.0.0" }, versions: alphaVersions }));
  await writeFile(join(root, "registry-receipt.json"), JSON.stringify({
    type: "SemioticVoxelPackageRegistryReceipt",
    version: 2,
    registry: "http://registry.invalid/",
    packages: [...packages, packages[2]],
    scopes: ["customer"],
  }));
  return root;
}

async function withHttpFace(root, work) {
  const server = createHttpServer({ handle: async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://registry.invalid").pathname;
    const file = pathname === "/registry-receipt.json"
      ? join(root, "registry-receipt.json")
      : join(root, "metadata", `${encodeURIComponent(decodeURIComponent(pathname.slice(1)))}.json`);
    let body;
    try { body = await readFile(file); } catch (error) {
      if (error?.code === "ENOENT") response.writeHead(404, { "content-type": "application/json", connection: "close" }).end('{"error":"not_found"}');
      else response.writeHead(500, { connection: "close" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json", connection: "close" }).end(body);
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await work({ registryUrl: `http://127.0.0.1:${port}/` });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function withoutRegistryLocation(answer) {
  const { registry, ...rest } = answer;
  return rest;
}

test("disk and HTTP npm faces give identical query and interface answers", async () => {
  const root = await fixtureRegistry();
  try {
    const disk = { registryRoot: root };
    await withHttpFace(root, async (http) => {
      const diskAnswers = await Promise.all([
        packageExists({ ...disk, name: "@customer/alpha" }),
        packageExists({ ...disk, name: "@customer/missing" }),
        searchPackages({ ...disk, pattern: "customer" }),
        dependenciesOf({ ...disk, name: "@customer/alpha" }),
        dependenciesOf({ ...disk, name: "@customer/alpha", version: "1.0.0" }),
        dependentsOf({ ...disk, name: "@customer/beta" }),
        interfacesOf({ ...disk, name: "@customer/alpha" }),
        interfacesOf({ ...disk, name: "@customer/alpha", version: "1.0.0" }),
      ]);
      const httpAnswers = await Promise.all([
        packageExists({ ...http, name: "@customer/alpha" }),
        packageExists({ ...http, name: "@customer/missing" }),
        searchPackages({ ...http, pattern: "customer" }),
        dependenciesOf({ ...http, name: "@customer/alpha" }),
        dependenciesOf({ ...http, name: "@customer/alpha", version: "1.0.0" }),
        dependentsOf({ ...http, name: "@customer/beta" }),
        interfacesOf({ ...http, name: "@customer/alpha" }),
        interfacesOf({ ...http, name: "@customer/alpha", version: "1.0.0" }),
      ]);
      assert.deepEqual(httpAnswers.map(withoutRegistryLocation), diskAnswers.map(withoutRegistryLocation));
      assert.deepEqual(diskAnswers[3].dependencies, [{ name: "@customer/beta", constraint: "2.0.0" }, { name: "@customer/zeta", constraint: "2.0.0" }]);
      assert.deepEqual(diskAnswers[4].dependencies, [{ name: "@customer/beta", constraint: "1.0.0" }]);
      assert.deepEqual(diskAnswers[5].dependents, [
        { name: "@customer/alpha", version: "1.0.0", constraint: "1.0.0" },
        { name: "@customer/alpha", version: "2.0.0", constraint: "2.0.0" },
        { name: "@customer/gamma", version: "1.0.0", constraint: "^1.0.0" },
      ]);
      assert.deepEqual(diskAnswers[6].interfaces.binaries, [{ name: "alpha", target: "scripts/alpha.mjs" }]);
      assert.deepEqual(diskAnswers[6].interfaces.scripts, [{ name: "verify", command: "node --test" }]);
      assert.deepEqual(diskAnswers[7].interfaces.binaries, [{ name: "alpha", target: "scripts/alpha.mjs" }]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("query source preserves receipt and packument bytes while selecting a release", async () => {
  const root = await fixtureRegistry();
  try {
    const source = openNpmRegistryQuerySource({ registryRoot: root });
    const receipt = await source.receipt();
    const packument = await source.packument("@customer/alpha");
    const release = await source.release("@customer/alpha");
    assert.ok(receipt.bytes.equals(await readFile(join(root, "registry-receipt.json"))));
    assert.ok(packument.bytes.equals(await readFile(join(root, "metadata", `${encodeURIComponent("@customer/alpha")}.json`))));
    assert.equal(release.version, "2.0.0");
    assert.equal(release.manifest.version, "2.0.0");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exact unknown versions are clean not-found dependency answers", async () => {
  const root = await fixtureRegistry();
  try {
    const answer = await dependenciesOf({ registryRoot: root, name: "@customer/alpha", version: "9.9.9" });
    assert.deepEqual(answer.dependencies, []);
    assert.equal(answer.found, false);
    assert.equal(answer.version, "9.9.9");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exact unknown versions are clean not-found interface answers", async () => {
  const root = await fixtureRegistry();
  try {
    const answer = await interfacesOf({ registryRoot: root, name: "@customer/alpha", version: "9.9.9" });
    assert.equal(answer.found, false);
    assert.equal(answer.version, "9.9.9");
    assert.equal(answer.interfaces, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI exposes the same exact-release interface readout", async () => {
  const root = await fixtureRegistry();
  try {
    const script = new URL("../scripts/query-npm-registry.mjs", import.meta.url);
    const { stdout } = await execute(process.execPath, [script.pathname, "--registry", root, "--interfaces-of", "@customer/alpha", "--version", "1.0.0"]);
    const answer = JSON.parse(stdout);
    assert.equal(answer.type, "NpmPackageInterfacesAnswer");
    assert.equal(answer.version, "1.0.0");
    assert.deepEqual(answer.interfaces.binaries, [{ name: "alpha", target: "scripts/alpha.mjs" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed documents and absent receipts have the same clear behavior on disk and HTTP faces", async () => {
  const root = await fixtureRegistry();
  try {
    await writeFile(join(root, "metadata", `${encodeURIComponent("@customer/alpha")}.json`), "not json");
    await assert.rejects(() => packageExists({ registryRoot: root, name: "@customer/alpha" }), /packument for @customer\/alpha is not a valid JSON object/);
    await assert.rejects(() => packageExists({
      registryUrl: "https://registry.example.test/",
      name: "@customer/alpha",
      fetchImplementation: async () => ({ status: 200, ok: true, arrayBuffer: async () => Buffer.from("not json") }),
    }), /packument for @customer\/alpha is not a valid JSON object/);
    await unlink(join(root, "registry-receipt.json"));
    await assert.rejects(() => searchPackages({ registryRoot: root, pattern: "alpha" }), /registry has no recognized build receipt/);
    await assert.rejects(() => dependentsOf({
      registryUrl: "https://registry.example.test/",
      name: "@customer/beta",
      fetchImplementation: async () => ({ status: 404, ok: false }),
    }), /registry has no recognized build receipt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("search is deterministic even for stateful regular expressions", async () => {
  const root = await fixtureRegistry();
  try {
    const answer = await searchPackages({ registryRoot: root, pattern: /@customer\/(alpha|beta|gamma)/gu });
    assert.deepEqual(answer.matches, ["@customer/alpha", "@customer/beta", "@customer/gamma"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses ambiguous registries and invalid exact-version selectors", async () => {
  await assert.rejects(() => packageExists({ registryRoot: "/tmp/a", registryUrl: "http://x/", name: "@customer/alpha" }), TypeError);
  await assert.rejects(() => packageExists({ name: "@customer/alpha" }), TypeError);
  await assert.rejects(() => dependenciesOf({ registryRoot: "/tmp/a", name: "@customer/alpha", version: "" }), TypeError);
  await assert.rejects(() => interfacesOf({ registryRoot: "/tmp/a", name: "@customer/alpha", version: "" }), TypeError);
});
