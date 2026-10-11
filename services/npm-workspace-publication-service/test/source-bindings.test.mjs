import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { withSourceBindings } from "../src/source-bindings.mjs";

async function packageAt(root, name, version, source) {
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version, type: "module", main: "./index.mjs", scripts: { test: "node --test" } }));
  await writeFile(join(root, "index.mjs"), source);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-bindings-"));
  const provider = join(root, "provider"), consumer = join(root, "consumer"), installed = join(consumer, "node_modules", "@scope", "provider");
  await mkdir(installed, { recursive: true });
  await mkdir(provider, { recursive: true });
  await mkdir(consumer, { recursive: true });
  await packageAt(provider, "@scope/provider", "1.2.3", "export const value = 'source';\n");
  await packageAt(installed, "@scope/provider", "1.2.3", "export const value = 'installed';\n");
  await packageAt(consumer, "@scope/consumer", "1.0.0", "import { value } from '@scope/provider'; export { value };\n");
  const providerPkg = { name: "@scope/provider", version: "1.2.3", dir: provider, lifecycle: ["test"] };
  const consumerPkg = { name: "@scope/consumer", version: "1.0.0", dir: consumer, lifecycle: ["test"] };
  return { root, consumer, installed, plan: { packages: [providerPkg, consumerPkg], dependencies: { "@scope/provider": [], "@scope/consumer": ["@scope/provider"] } } };
}

test("source bindings make a selected exact provider win over a stale installation and restore it", async () => {
  const { consumer, installed, plan } = await fixture();
  const observed = await withSourceBindings(plan, async () => (await import(`${pathToFileURL(join(consumer, "index.mjs")).href}?bound=1`)).value);
  assert.equal(observed, "source");
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.match(await readFile(join(installed, "index.mjs"), "utf8"), /installed/);
});

test("source bindings restore stale installations after a failed verification command", async () => {
  const { installed, plan } = await fixture();
  await assert.rejects(withSourceBindings(plan, async () => { throw new Error("expected failure"); }), /expected failure/);
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.match(await readFile(join(installed, "index.mjs"), "utf8"), /installed/);
});

test("source-bound verification refuses lifecycle installation before changing a target", async () => {
  const { consumer, installed, plan } = await fixture();
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "@scope/consumer", version: "1.0.0", type: "module", scripts: { test: "npm install" } }));
  await assert.rejects(withSourceBindings(plan, async () => assert.fail("verification must not run")), /npm installation is not permitted/);
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.match(await readFile(join(installed, "index.mjs"), "utf8"), /installed/);
});
