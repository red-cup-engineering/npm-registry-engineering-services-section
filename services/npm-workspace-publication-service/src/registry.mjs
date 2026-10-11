import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { execFile as execFileCallback } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { correctedTarballURL } from "./tarball-guard.mjs";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";

const execFile = promisify(execFileCallback);
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

/** Read the exact version index directly from a locally mounted Verdaccio store. */
export async function readRegistryStorageVersions(storageRoot, names) {
  const result = new Map();
  for (const name of [...new Set(names)]) {
    try {
      const path = join(resolve(storageRoot), ...name.split("/"), "package.json");
      const packument = JSON.parse(await readFile(path, "utf8"));
      if (packument?.name !== name || !packument.versions || typeof packument.versions !== "object") {
        throw new Error(`registry storage contains malformed metadata for ${name}`);
      }
      result.set(name, new Set(Object.keys(packument.versions)));
    } catch (error) {
      if (error?.code === "ENOENT") result.set(name, new Set());
      else throw error;
    }
  }
  return result;
}

export async function readRegistryStorageDistTag(storageRoot, name, tag) {
  try {
    const path = join(resolve(storageRoot), ...name.split("/"), "package.json");
    const packument = JSON.parse(await readFile(path, "utf8"));
    if (packument?.name !== name || !packument["dist-tags"] || typeof packument["dist-tags"] !== "object") throw new Error(`registry storage contains malformed dist-tags for ${name}`);
    return Object.freeze({ reachable: true, found: true, version: packument["dist-tags"][tag] ?? null });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ reachable: true, found: false, version: null });
    throw error;
  }
}

/**
 * Repair a single published version's `dist.tarball` in a locally mounted
 * Verdaccio store, in place, when it carries the npm-client tarball-URL
 * corruption described in `correctedTarballURL`. A no-op (returns
 * `{ changed: false }`) when the version is absent or already well-formed, so
 * it is safe to call unconditionally after every publish.
 */
export async function repairStorageTarballURL(storageRoot, name, version) {
  const path = join(resolve(storageRoot), ...name.split("/"), "package.json");
  const raw = await readFile(path, "utf8");
  const packument = JSON.parse(raw);
  if (packument?.name !== name) throw new Error(`registry storage contains malformed metadata for ${name}`);
  const manifest = packument.versions?.[version];
  if (!manifest) return Object.freeze({ changed: false, reason: "version-absent" });
  const corrected = correctedTarballURL(manifest.dist?.tarball, name);
  if (corrected === null) return Object.freeze({ changed: false });
  manifest.dist.tarball = corrected;
  await writeFileText(path, `${JSON.stringify(packument, null, 2)}\n`);
  return Object.freeze({ changed: true, tarball: corrected });
}

function readPackument(url) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith("https:") ? httpsGet : httpGet;
    const token = process.env.NODE_AUTH_TOKEN;
    const headers = { connection: "close", ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const request = getter(url, { agent: false, headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024 * 1024) request.destroy(new Error("registry response exceeds 64 MiB"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          resolve({ ok: false, status: response.statusCode, json: async () => null });
          return;
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ ok: true, status: response.statusCode, json: async () => value });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("registry request timed out")));
    request.on("error", reject);
  });
}

/** Read all versions known for one package name. */
export async function readRegistryPackage(registry, name) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const url = `${base}${name.replace("/", "%2F")}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await readPackument(url);
      if (!response.ok) return Object.freeze({ found: false, reachable: true, packument: null });
      return Object.freeze({ found: true, reachable: true, packument: Object.freeze(await response.json()) });
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  return Object.freeze({ found: false, reachable: false, packument: null });
}

export async function readRegistryDistTag(registry, name, tag) {
  const result = await readRegistryPackage(registry, name);
  return Object.freeze({ reachable: result.reachable, found: result.found, version: result.packument?.["dist-tags"]?.[tag] ?? null });
}

/** Read the immutable manifest Verdaccio serves for one exact package identity. */
export async function readRegistryPackageVersion(registry, name, version) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const url = `${base}${name.replace("/", "%2F")}/${encodeURIComponent(version)}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await readPackument(url);
      if (!response.ok) return Object.freeze({ found: false, reachable: true, manifest: null });
      return Object.freeze({ found: true, reachable: true, manifest: Object.freeze(await response.json()) });
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  return Object.freeze({ found: false, reachable: false, manifest: null });
}

function commandText(error) {
  return [error?.stdout, error?.stderr, error?.message].filter((value) => typeof value === "string").join("\n").toLowerCase();
}

function configuredRegistryAuthority(registry) {
  const url = new URL(registry);
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("registry must be an authority-only HTTP(S) URL");
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

function exactNpmIdentity(name, version) {
  if (typeof name !== "string" || !/^@?[a-z0-9][a-z0-9._@/~-]*$/iu.test(name) || name.includes("//") || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new TypeError("name and version must identify one exact npm package");
  }
  return `${name}@${version}`;
}

async function configuredNpmCommand(command, arguments_, { registry, npmEnvironment, execFileImpl, options }) {
  const environment = { ...process.env, ...npmEnvironment };
  if (environment.NODE_AUTH_TOKEN === undefined) return execFileImpl(command, arguments_, { ...options, env: environment });
  const configuration = await mkdtemp(join(tmpdir(), "npm-configured-registry-"));
  const npmrc = join(configuration, ".npmrc");
  const url = new URL(registry);
  // npm resolves this variable itself; the protected token is never written.
  await writeFile(npmrc, `registry=${registry}\n//${url.host}${url.pathname}:_authToken=\${NODE_AUTH_TOKEN}\n`, { mode: 0o600 });
  try {
    return await execFileImpl(command, arguments_, { ...options, env: { ...environment, NPM_CONFIG_USERCONFIG: npmrc } });
  } finally {
    await rm(configuration, { recursive: true, force: true });
  }
}

/**
 * Reads exact package metadata through npm's configured authentication.
 * @param {string} registry
 * @param {string} name
 * @param {string} version
 * @param {{execFileImpl?: typeof execFile, npmEnvironment?: Record<string, string>}} [options]
 * @returns {Promise<{found: boolean, reachable: boolean, authorizationFailed?: boolean, manifest: object|null}>}
 */
export async function readConfiguredNpmRegistryPackageVersion(registry, name, version, { execFileImpl = execFile, npmEnvironment = {} } = {}) {
  const authority = configuredRegistryAuthority(registry), identity = exactNpmIdentity(name, version);
  try {
    const { stdout } = await configuredNpmCommand("npm", ["view", identity, "--json", "--fetch-retries=0", "--fetch-timeout=5000", "--registry", authority], { registry: authority, npmEnvironment, execFileImpl, options: { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 } });
    const manifest = JSON.parse(stdout);
    return Object.freeze({ found: true, reachable: true, manifest: Object.freeze(manifest) });
  } catch (error) {
    const detail = commandText(error);
    if (/\b(?:e401|e403)\b|(?:authorization|authentication)\s+(?:required|failed)|(?:access|permission)\s+denied|forbidden/u.test(detail)) {
      return Object.freeze({ found: false, reachable: true, authorizationFailed: true, manifest: null });
    }
    if (/\be404\b|not found/u.test(detail)) return Object.freeze({ found: false, reachable: true, manifest: null });
    return Object.freeze({ found: false, reachable: false, manifest: null });
  }
}

/**
 * Downloads one exact registry tarball through npm's configured authentication
 * and verifies its advertised SHA-512 before retaining it.
 * @param {{registry: string, name: string, version: string, integrity: string, destination: string, execFileImpl?: typeof execFile, npmEnvironment?: Record<string, string>}} input
 * @returns {Promise<void>}
 */
export async function downloadConfiguredNpmRegistryTarball({ registry, name, version, integrity, destination, execFileImpl = execFile, npmEnvironment = {} }) {
  const authority = configuredRegistryAuthority(registry), identity = exactNpmIdentity(name, version);
  if (!SHA512_INTEGRITY.test(integrity)) throw new TypeError("registry tarball integrity must be sha512");
  try {
    const existing = await readFile(destination);
    if (`sha512-${createHash("sha512").update(existing).digest("base64")}` !== integrity) throw new Error(`existing registry artifact ${name}@${version} has conflicting bytes`);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${destination}.npm-pack-${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const { stdout } = await configuredNpmCommand("npm", ["pack", identity, "--json", "--ignore-scripts", "--fetch-retries=0", "--fetch-timeout=5000", "--registry", authority], { registry: authority, npmEnvironment, execFileImpl, options: { cwd: staging, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 } });
    const record = JSON.parse(stdout)?.[0];
    if (record?.name !== name || record?.version !== version || typeof record.filename !== "string" || record.filename.includes("/") || record.filename.includes("\\") || record.filename === "." || record.filename === "..") {
      throw new Error(`npm pack did not identify ${name}@${version}`);
    }
    const bytes = await readFile(join(staging, record.filename));
    const observed = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (observed !== integrity) throw new Error(`registry artifact ${name}@${version} integrity mismatch`);
    try { await link(join(staging, record.filename), destination); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(destination);
      if (`sha512-${createHash("sha512").update(existing).digest("base64")}` !== integrity) throw new Error(`existing registry artifact ${name}@${version} has conflicting bytes`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** True when the registry already serves exactly this name@version. */
export async function isVersionPublished(registry, name, version, fetcher = fetch) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const packumentUrl = `${base}${name.replace("/", "%2F")}`;
  const useNativeTransport = fetcher === fetch;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = useNativeTransport
        ? await readPackument(packumentUrl)
        : await fetcher(packumentUrl, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return Object.freeze({ published: false, reachable: true });
      const packument = await response.json();
      return Object.freeze({
        published: Boolean(packument?.versions?.[version]),
        reachable: true,
      });
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  return Object.freeze({ published: false, reachable: false });
}
