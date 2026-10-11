import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "node:test";
import { internalDependencyGraph, workspaceDependencyClosure, leafFirstTiers } from "../src/workspace-graph.mjs";
import { scanWorkspacePackages } from "../src/read-workspace-manifests.mjs";
import { isVersionPublished } from "../src/registry.mjs";
import { createServer as createLoopbackServer } from "node:http";

/** A loopback fixture server over the platform HTTP runtime; the code under test is its client. */
const createHttpServer = ({ handle }) => createLoopbackServer(handle);

const pkg = (name, deps = {}, version = "1.0.0") => ({ name, version, dir: `/x/${name}-${version}`, dependencies: deps });

test("internal edges are exactly dependencies that are themselves workspace members", () => {
  const packages = [pkg("a"), pkg("b", { a: "1.0.0", "left-pad": "1.0.0" }), pkg("old-a-consumer", { a: "0.9.0" })];
  const { edges } = internalDependencyGraph(packages);
  assert.deepEqual(edges.get("b"), ["a"]);
  assert.deepEqual(edges.get("a"), []);
  assert.deepEqual(edges.get("old-a-consumer"), []);
});

test("tiers are leaf-first and respect dependency order", () => {
  const packages = [pkg("app", { lib: "1.0.0", codec: "1.0.0" }), pkg("lib", { codec: "1.0.0" }), pkg("codec")];
  const { tiers, cyclic } = leafFirstTiers(packages);
  assert.deepEqual(tiers, [["codec"], ["lib"], ["app"]]);
  assert.deepEqual(cyclic, []);
});

test("an explicit package selection includes its complete local dependency closure", () => {
  const packages = [pkg("app", { lib: "1.0.0", external: "1.0.0" }), pkg("lib", { codec: "1.0.0" }), pkg("codec"), pkg("other")];
  assert.deepEqual(workspaceDependencyClosure(packages, ["app"]).map(({ name }) => name), ["app", "lib", "codec"]);
});

test("clean-verification dependencies participate in closure and tier order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "publication-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const manifest of [
    { name: "app", version: "1.0.0", devDependencies: { verifier: "1.0.0" }, peerDependencies: { protocol: "1.0.0" } },
    { name: "verifier", version: "1.0.0" },
    { name: "protocol", version: "1.0.0" },
  ]) {
    const directory = join(root, manifest.name);
    await mkdir(directory);
    await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
  }
  const packages = await scanWorkspacePackages(root);
  const selected = workspaceDependencyClosure(packages, ["app"]);
  assert.deepEqual(selected.map(({ name }) => name), ["app", "protocol", "verifier"]);
  assert.deepEqual(leafFirstTiers(selected).tiers, [["protocol", "verifier"], ["app"]]);
});

test("a local name at a different version is not part of a release closure", () => {
  const packages = [pkg("app", { lib: "0.9.0" }), pkg("lib")];
  assert.deepEqual(workspaceDependencyClosure(packages, ["app"]).map(({ name }) => name), ["app"]);
});

test("an exact dependency selects only its matching same-name workspace site", () => {
  const packages = [
    pkg("app", { lib: "2.0.0" }),
    pkg("lib", { codec: "2.0.0" }, "1.0.0"),
    pkg("lib", { codec: "2.0.0" }, "2.0.0"),
    pkg("codec", {}, "1.0.0"),
    pkg("codec", {}, "2.0.0"),
  ];
  assert.deepEqual(
    workspaceDependencyClosure(packages, ["app"]).map(({ name, version }) => `${name}@${version}`),
    ["app@1.0.0", "lib@2.0.0", "codec@2.0.0"],
  );
});

test("an explicit package selection refuses absent and duplicated identities", () => {
  assert.throws(() => workspaceDependencyClosure([pkg("app")], ["absent"]), /workspace package is absent/);
  assert.throws(() => workspaceDependencyClosure([pkg("app"), pkg("app")], ["app"]), /workspace package identity is duplicated/);
  assert.throws(() => workspaceDependencyClosure([pkg("app", {}, "1.0.0"), pkg("app", {}, "2.0.0")], ["app"]), /workspace package identity is duplicated/);
});

test("a dependency cycle is reported, not thrown, and does not poison the rest", () => {
  const packages = [pkg("x", { y: "1.0.0" }), pkg("y", { x: "1.0.0" }), pkg("solo")];
  const { tiers, cyclic } = leafFirstTiers(packages);
  assert.deepEqual(tiers, [["solo"]]);
  assert.deepEqual(cyclic, ["x", "y"]);
});

test("isVersionPublished distinguishes published, absent, and unreachable", async () => {
  const packument = { versions: { "1.0.0": {} } };
  const okFetch = async () => ({ ok: true, json: async () => packument });
  const missFetch = async () => ({ ok: false });
  const downFetch = async () => { throw new Error("refused"); };
  assert.deepEqual(await isVersionPublished("http://r/", "a", "1.0.0", okFetch), { published: true, reachable: true });
  assert.deepEqual(await isVersionPublished("http://r/", "a", "2.0.0", okFetch), { published: false, reachable: true });
  assert.deepEqual(await isVersionPublished("http://r/", "a", "1.0.0", missFetch), { published: false, reachable: true });
  assert.deepEqual(await isVersionPublished("http://r/", "a", "1.0.0", downFetch), { published: false, reachable: false });
});

test("native registry reads carry the admitted short-lived bearer token", async (t) => {
  const prior = process.env.NODE_AUTH_TOKEN;
  process.env.NODE_AUTH_TOKEN = "ephemeral-test-token";
  t.after(() => { if (prior === undefined) delete process.env.NODE_AUTH_TOKEN; else process.env.NODE_AUTH_TOKEN = prior; });
  let authorization = null;
  let requestUrl = null;
  const server = createHttpServer({ handle: (request, response) => {
    authorization = request.headers.authorization;
    requestUrl = request.url;
    response.writeHead(200, { "content-type": "application/json" }).end('{"versions":{"1.0.0":{}}}');
  } });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  t.after(() => server.close());
  const { port } = server.address();
  assert.deepEqual(await isVersionPublished(`http://127.0.0.1:${port}/`, "a", "1.0.0"), { published: true, reachable: true });
  assert.equal(authorization, "Bearer ephemeral-test-token");
  assert.equal(requestUrl, "/a");
});
