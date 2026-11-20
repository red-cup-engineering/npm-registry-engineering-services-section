import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {chmod, mkdtemp, readFile, readdir, readlink, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {test} from "node:test";
import {admittedConfiguration, npmRegistryHostedApplication, registryFor} from "../src/application.mjs";
import {createGuixArchiveStorage} from "../src/guix-archive-registration.mjs";

const configuration = root => ({hosts: ["registry.example.test"], origin: "https://registry.example.test",
  storage: join(root, "storage"), htpasswd: join(root, "htpasswd"), tokens: join(root, "tokens")});
const archives = {roots: "/var/guix/profiles/per-user/emsenn/registry-fixture", program: "/usr/local/bin/guix"};

test("archive custody is an explicit closed configuration and requires the native supervisor", async t => {
  const root = await mkdtemp(join(tmpdir(), "registry-archive-configuration-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const declared = configuration(root);
  for (const guixArchives of [null, [], {}, {...archives, roots: "relative"}, {...archives, program: "/bin/../guix"}, {...archives, unknown: true}])
    assert.throws(() => admittedConfiguration({...declared, guixArchives}), /Guix archive custody/u);
  assert.throws(() => npmRegistryHostedApplication({configuration: {...declared, guixArchives: archives}}), /native application supervisor/u);
  assert.throws(() => registryFor({...declared, guixArchives: archives}), /native storage port/u);
  const application = npmRegistryHostedApplication({configuration: declared});
  assert.deepEqual(application.authentication.accepts, ["Basic", "Bearer"]);
  assert.equal((await application.fetch(new Request(declared.origin + "/-/whoami"))).status, 401);
  assert.deepEqual(await readdir(root), []);
});

test("entrance rebuilds retain one archive service and original registry writer per store", async t => {
  const root = await mkdtemp(join(tmpdir(), "registry-archive-rebuild-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const definitions = new Map(), handles = new Map();
  const services = {ensure(name, definition) {
    if (!handles.has(name)) {
      definitions.set(name, definition);
      handles.set(name, {value: () => undefined});
    }
    return handles.get(name);
  }};
  const declared = {...configuration(root), guixArchives: archives};
  const first = npmRegistryHostedApplication({configuration: declared, services});
  const second = npmRegistryHostedApplication({configuration: declared, services});
  assert.equal(definitions.size, 1);
  assert.deepEqual(first.hosts, second.hosts);
  npmRegistryHostedApplication({configuration: {...declared, storage: join(root, "other")}, services});
  assert.equal(definitions.size, 2);
  assert.deepEqual(await readdir(root), []);
  const abort = new AbortController();
  abort.abort(new Error("fixture drain"));
  await assert.rejects(definitions.values().next().value.start({signal: abort.signal}), /fixture drain/u);
});

test("hosted archive custody uses the native supervisor and exact original Guix registration", {
  skip: process.env.NPM_REGISTRY_TEST_NATIVE_GUIX !== "1" || !process.env.NPM_REGISTRY_TEST_GUIX ||
    !process.env.NPM_REGISTRY_TEST_APPLICATION_SERVICES || !process.env.NPM_REGISTRY_TEST_COLLECTOR_PARENT,
}, async t => {
  const {createApplicationServices} = await import(pathToFileURL(process.env.NPM_REGISTRY_TEST_APPLICATION_SERVICES));
  const root = await mkdtemp(join(tmpdir(), "registry-hosted-archive-"));
  const collector = await mkdtemp(join(process.env.NPM_REGISTRY_TEST_COLLECTOR_PARENT, "registry-hosted-"));
  await chmod(collector, 0o755);
  const services = createApplicationServices({log() {}});
  t.after(async () => {
    await services.close();
    await rm(root, {recursive: true, force: true});
    await rm(collector, {recursive: true, force: true});
  });
  const guixArchives = {roots: collector, program: process.env.NPM_REGISTRY_TEST_GUIX};
  const declared = {...configuration(root), guixArchives};
  npmRegistryHostedApplication({configuration: declared, services});
  await new Promise(resolve => setImmediate(resolve));
  const name = services.status()[0].name;
  const handle = services.ensure(name);
  assert.equal(handle.state(), "running");
  const bytes = Buffer.from("native registry archive custody fixture\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const stored = await handle.value().storeArchive(bytes);
  assert.deepEqual(await readFile(stored), bytes);
  assert.equal(await readlink(join(collector, digest + ".tgz")), stored);
  npmRegistryHostedApplication({configuration: declared, services});
  assert.equal(services.status().length, 1);
  assert.equal(await handle.value().storeArchive(bytes), stored);
  const standalone = createGuixArchiveStorage({storage: join(root, "standalone"), roots: collector, guix: guixArchives.program});
  try { assert.equal(await standalone.storeArchive(bytes), stored); }
  finally { await standalone.close(); }
  assert.deepEqual(await readdir(declared.storage), []);
  await services.close();
  assert.equal(handle.state(), "stopped");
  await assert.rejects(handle.value()?.storeArchive(bytes) ?? Promise.reject(new Error("service stopped")), /closed|stopped/u);
});
