import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { createNpmRegistry } from "../../src/registry.mjs";
import { readTarball } from "../../src/tarball-reader.mjs";

export const run = promisify(execFile);
export const password = "local-disposable-test-only";
export const authorization = `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`;
const digest = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

/** A publish PUT body for a tarball, as npm sends it: its own package.json as the manifest, the bytes attached. */
export function publishBody(bytes, { origin = "http://registry.invalid", tag = "latest", manifest: extra = {} } = {}) {
  const manifest = { repository: { type: "git", url: "https://github.com/registry-fixture/capability.git" }, ...JSON.parse(readTarball(bytes).get("package.json")), ...extra };
  const file = `${manifest.name.split("/").pop()}-${manifest.version}.tgz`;
  return {
    name: manifest.name, "dist-tags": { [tag]: manifest.version },
    versions: { [manifest.version]: { ...manifest, dist: { tarball: `${origin}/${manifest.name}/-/${file}`, shasum: digest("sha1", bytes, "hex"), integrity: `sha512-${digest("sha512", bytes, "base64")}` } } },
    _attachments: { [`${manifest.name}-${manifest.version}.tgz`]: { content_type: "application/octet-stream", data: bytes.toString("base64"), length: bytes.length } },
  };
}

/** A registry handler over a scratch store, for requests made in process. */
export async function registryFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "house-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const htpasswd = join(root, "htpasswd");
  await writeFile(htpasswd, `fixture:${bcrypt.hashSync(password, 4)}\n`);
  const storage = join(root, "storage");
  const origin = "http://registry.invalid";
  const registry = createNpmRegistry({ storage, htpasswd, origin, privateScopes: ["@registry-fixture", "@red-cup-engineering"], ...options });
  const request = (path, init) => registry.handle(new Request(`${origin}${path}`, init));
  const put = (name, body, headers = { authorization }) => request(`/${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { root, storage, origin, request, put, publish: (bytes, extra) => { const body = publishBody(bytes, { origin, ...extra }); return put(body.name, body); } };
}

/** The serving entrypoint on a free local port, for the real npm and pnpm CLIs to talk to. `accesses()` reads the
 *  requests it answered (NPM_REGISTRY_ACCESS_LOG). */
export async function liveRegistry(t, { privateScopes = ["@registry-fixture"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "house-registry-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const htpasswd = join(root, "htpasswd"), storage = join(root, "storage");
  await writeFile(htpasswd, `fixture:${bcrypt.hashSync(password, 4)}\n`);
  const probe = createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const config = join(root, "registry.json");
  await writeFile(config, JSON.stringify({ hosts: ["127.0.0.1"], origin, storage, htpasswd, privateScopes }));
  const server = spawn(process.execPath, [fileURLToPath(new URL("../../bin/serve.mjs", import.meta.url)), config], { env: { PATH: process.env.PATH, NPM_REGISTRY_PORT: String(port), NPM_REGISTRY_ACCESS_LOG: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; server.stderr.on("data", b => { errors += b; });
  const accesses = () => errors.split("\n").filter(line => line.startsWith('{"method"')).map(line => JSON.parse(line));
  t.after(async () => { if (server.exitCode === null) { server.kill("SIGTERM"); await new Promise(r => server.once("exit", r)); } });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/-/ping`)).ok) break; } catch { /* wait for the entrypoint */ }
    if (attempt === 200 || server.exitCode !== null) throw new Error(`registry did not start: ${errors}`);
    await new Promise(r => setTimeout(r, 20));
  }
  const userconfig = join(root, "npmrc"), globalconfig = join(root, "global-npmrc");
  await writeFile(userconfig, `registry=${origin}\n//127.0.0.1:${port}/:username=fixture\n//127.0.0.1:${port}/:_password=${Buffer.from(password).toString("base64")}\n`);
  await writeFile(globalconfig, "");
  const env = {
    PNPM_MAX_WORKERS: "1", NODE_DISABLE_COMPILE_CACHE: "1",
    PATH: process.env.PATH, HOME: root, PNPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig, NPM_CONFIG_CACHE: join(root, "cache"), NO_PROXY: "127.0.0.1",
    // pnpm reads the same .npmrc and keeps its store, metadata cache and state inside the fixture.
    XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"), XDG_CONFIG_HOME: join(root, "xdg-config"),
  };
  const npm = (args, cwd = root) => run("npm", [...args, "--registry", origin], { cwd, env });
  // pnpm runs in isolation; ignore workspace to avoid inheriting ancestor workspaces
  const pnpm = (args, cwd = root) => run("pnpm", ["--ignore-workspace", ...args, "--registry", origin], { cwd, env });
  /** Write a package directory and `npm publish` it. */
  const publishPackage = async (name, version, files = {}, extra = {}, args = []) => {
    const dir = join(root, "src", `${name.replace(/\W/gu, "-")}-${version}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./index.mjs", files: ["index.mjs"], repository: { type: "git", url: "https://github.com/registry-fixture/capability.git" }, ...extra }));
    await writeFile(join(dir, "index.mjs"), files["index.mjs"] ?? `export const version = ${JSON.stringify(version)};\n`);
    return npm(["publish", "--ignore-scripts", "--provenance=false", ...args], dir);
  };
  return { root, storage, origin, port, userconfig, env, npm, pnpm, accesses, publishPackage, packument: async (name) => (await fetch(`${origin}/${encodeURIComponent(name)}`)).json() };
}
