import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { liveRegistry, password } from "./support/registry.mjs";

// The installed npm and pnpm clients against the standalone entrypoint: what they send is what they send, and the
// registry is conformant when they do what they do against registry.npmjs.org.

const run = promisify(execFile);
const name = "@registry-fixture/capability";
const has = (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;

async function consumer(f, label) {
  const directory = join(f.root, label);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: label, private: true, type: "module" }));
  return directory;
}
const imported = async (f, directory) => (await run(process.execPath, ["--input-type=module", "-e", `process.stdout.write((await import(${JSON.stringify(name)})).version)`], { cwd: directory, env: f.env })).stdout;

test("real pnpm: publishes, installs, and revalidates its cached metadata with a conditional request the registry answers 304", { skip: !has("pnpm") && "pnpm is not installed", timeout: 180_000 }, async (t) => {
  const f = await liveRegistry(t);
  // pnpm 11 holds back versions younger than a day by default (the house sets the same cooldown, with exclusions);
  // these were published a moment ago, and the cooldown is the client's policy, not the registry's protocol.
  Object.assign(f.env, { PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0", PNPM_CONFIG_UPDATE_NOTIFIER: "false" });
  const source = join(f.root, "source");
  await mkdir(source);
  const manifest = (version) => ({ name, version, type: "module", exports: "./index.mjs", files: ["index.mjs"], repository: { type: "git", url: "https://github.com/registry-fixture/capability.git" } });
  for (const version of ["1.0.0", "1.1.0"]) {
    await writeFile(join(source, "package.json"), JSON.stringify(manifest(version)));
    await writeFile(join(source, "index.mjs"), `export const version = ${JSON.stringify(version)};\n`);
    await f.pnpm(["publish", "--no-git-checks"], source);
  }
  const first = await consumer(f, "first");
  await f.pnpm(["add", `${name}@^1.0.0`], first);
  assert.equal(await imported(f, first), "1.1.0");
  const metadata = f.accesses().filter((access) => access.method === "GET" && /capability$/iu.test(decodeURIComponent(access.path)));
  assert.ok(metadata.length > 0 && metadata.every((access) => access.status === 200 && access.gzip), JSON.stringify(metadata));
  const before = f.accesses().length;
  const second = await consumer(f, "second");
  await f.pnpm(["add", `${name}@^1.0.0`], second);
  assert.equal(await imported(f, second), "1.1.0");
  const revalidated = f.accesses().slice(before).filter((access) => access.method === "GET" && /capability$/iu.test(decodeURIComponent(access.path)));
  assert.ok(revalidated.length > 0, "pnpm asked the registry again");
  assert.ok(revalidated.every((access) => access.ifNoneMatch && access.status === 304), JSON.stringify(revalidated));
  // A publication changes the representation: the next revalidation is answered with it.
  await writeFile(join(source, "package.json"), JSON.stringify(manifest("1.2.0")));
  await writeFile(join(source, "index.mjs"), 'export const version = "1.2.0";\n');
  await f.pnpm(["publish", "--no-git-checks"], source);
  const third = await consumer(f, "third");
  await f.pnpm(["add", `${name}@^1.0.0`], third);
  assert.equal(await imported(f, third), "1.2.0");
});

test("real npm: a token from signing in publishes and answers whoami, and npm logout revokes it", { timeout: 120_000 }, async (t) => {
  const f = await liveRegistry(t);
  // Sign in exactly as npm's legacy login does (npm-profile loginCouch), then let npm use the token.
  const response = await fetch(`${f.origin}/-/user/org.couchdb.user:fixture`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ _id: "org.couchdb.user:fixture", name: "fixture", password, type: "user", roles: [], date: new Date().toISOString() }) });
  assert.equal(response.status, 201);
  const { token } = await response.json();
  await writeFile(f.userconfig, `registry=${f.origin}\n//127.0.0.1:${f.port}/:_authToken=${token}\n`);
  assert.equal((await f.npm(["whoami"])).stdout.trim(), "fixture");
  await f.publishPackage(name, "1.0.0");
  assert.deepEqual((await f.packument(name)).versions["1.0.0"]._npmUser, { name: "fixture" });
  await f.npm(["logout"]);
  assert.doesNotMatch(await readFile(f.userconfig, "utf8"), /_authToken/u, "npm forgot the token");
  assert.equal((await fetch(`${f.origin}/-/whoami`, { headers: { authorization: `Bearer ${token}` } })).status, 401, "and the registry revoked it");
});

test("real npm login, at a terminal, falls back from web login to signing in with the publisher's password", { skip: !has("script") && "script(1) is not installed", timeout: 120_000 }, async (t) => {
  const f = await liveRegistry(t);
  await writeFile(f.userconfig, `registry=${f.origin}\n`);
  // npm reads the password silently from a terminal; script(1) gives it one, and the answers arrive as it asks.
  const answers = `sleep 3; printf 'fixture\\n'; sleep 2; printf '%s\\n' "$NPM_LOGIN_PASSWORD"; sleep 4`;
  const login = spawnSync("sh", ["-c", `(${answers}) | script -q -c "npm login --registry ${f.origin}" /dev/null`], { env: { ...f.env, NPM_LOGIN_PASSWORD: password }, encoding: "utf8", timeout: 60_000 });
  assert.match(login.stdout, /Logged in/u, login.stdout + login.stderr);
  assert.match(await readFile(f.userconfig, "utf8"), /:_authToken=hnr_/u);
  assert.equal((await f.npm(["whoami"])).stdout.trim(), "fixture");
});
