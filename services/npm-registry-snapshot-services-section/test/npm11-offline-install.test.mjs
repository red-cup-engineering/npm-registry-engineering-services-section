import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createPackageRegistryServer, closeServer, listen } from "@red-cup-engineering/npm-registry-read-service";
import { assemblePackageRegistrySnapshot } from "../scripts/assemble-package-registry-snapshot.mjs";

const run = promisify(execFile);

async function npmTarball(root, manifest) {
  const directory = join(root, `carrier-${manifest.name.replaceAll("@", "").replaceAll("/", "-")}`);
  const packageDirectory = join(directory, "package");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(packageDirectory, "index.mjs"), "export const admitted = true;\n");
  const artifactPath = join(root, `${manifest.name.replaceAll("@", "").replaceAll("/", "-")}-${manifest.version}.tgz`);
  await run("tar", ["-czf", artifactPath, "package"], { cwd: directory });
  const bytes = await readFile(artifactPath);
  return { manifest, artifactPath, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

test("snapshot and read owners drive two deterministic npm 11 locks and a no-upstream npm ci", async (t) => {
  if (process.version !== "v24.19.0") return t.skip("owner proof is pinned to Node v24.19.0");
  const npmVersion = (await run("npm", ["--version"])).stdout.trim();
  if (npmVersion !== "11.17.0") return t.skip("owner proof is pinned to npm 11.17.0");
  const root = await mkdtemp("/tmp/npm-snapshot-offline-");
  try {
    const plain = await npmTarball(root, { name: "plain-provider", version: "2.0.0", type: "module", exports: "./index.mjs" });
    const scoped = await npmTarball(root, { name: "@customer/provider", version: "1.0.0", type: "module", exports: "./index.mjs", dependencies: { "plain-provider": "2.0.0" } });
    const registryDirectory = join(root, "registry");
    await assemblePackageRegistrySnapshot({ releases: [scoped, plain], outputDirectory: registryDirectory, registryUrl: "http://127.0.0.1:4873/" });
    const server = createPackageRegistryServer({ registryDirectory });
    await listen(server, { host: "127.0.0.1", port: 0 });
    try {
      const port = server.address().port;
      const registry = `http://127.0.0.1:${port}/`;
      const consumer = join(root, "consumer");
      await mkdir(consumer);
      await writeFile(join(consumer, "package.json"), `${JSON.stringify({ name: "consumer", version: "1.0.0", private: true, dependencies: { "@customer/provider": "1.0.0" } })}\n`);
      const config = join(root, "client.npmrc");
      await writeFile(config, `registry=${registry}\n@customer:registry=${registry}\naudit=false\nfund=false\n`);
      const environment = { PATH: process.env.PATH, HOME: root, NPM_CONFIG_USERCONFIG: config, NPM_CONFIG_GLOBALCONFIG: join(root, "empty-global.npmrc"), NPM_CONFIG_CACHE: join(root, "cache"), TMPDIR: "/tmp", TEMP: "/tmp", TMP: "/tmp" };
      await writeFile(environment.NPM_CONFIG_GLOBALCONFIG, "");
      const args = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`, `--@customer:registry=${registry}`];
      await run("npm", args, { cwd: consumer, env: environment });
      const first = await readFile(join(consumer, "package-lock.json"));
      await rm(join(consumer, "package-lock.json"));
      await run("npm", args, { cwd: consumer, env: environment });
      const second = await readFile(join(consumer, "package-lock.json"));
      assert.deepEqual(second, first);
      await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${registry}`, `--@customer:registry=${registry}`], { cwd: consumer, env: environment });
      assert.equal(JSON.parse(await readFile(join(consumer, "node_modules/@customer/provider/package.json"), "utf8")).version, "1.0.0");
      assert.equal(JSON.parse(await readFile(join(consumer, "node_modules/plain-provider/package.json"), "utf8")).version, "2.0.0");
    } finally { await closeServer(server); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
