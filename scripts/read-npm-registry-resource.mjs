import { join, resolve } from "node:path";

import { readFileBytes } from "@red-cup-engineering/file-services/read-file";

function registryFace(registryUrl) {
  const url = new URL(registryUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("registry URL must be HTTP(S)");
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

async function diskBytes(path) {
  try { return await readFileBytes(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function responseBytes(response, description) {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${description}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Long sequential audit runs against local Verdaccio occasionally see a bare
// connection reset (ECONNRESET) rather than an HTTP response. Retry a small,
// bounded number of times with a short linear backoff before giving up; an
// actual HTTP error response (4xx/5xx) is not retried here, only a fetch
// that throws.
async function fetchWithRetry(fetchImplementation, url, { attempts = RETRY_ATTEMPTS, delayMs = RETRY_DELAY_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImplementation(url);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

export function openNpmRegistry({ registryRoot, registryUrl, fetchImplementation = fetch } = {}) {
  if ((registryRoot === undefined) === (registryUrl === undefined)) {
    throw new TypeError("supply exactly one of registryRoot (directory) or registryUrl (HTTP face)");
  }
  if (registryUrl === undefined) {
    const root = resolve(registryRoot);
    return Object.freeze({
      registry: root,
      receiptBytes: () => diskBytes(join(root, "registry-receipt.json")),
      packumentBytes: (name) => diskBytes(join(root, "metadata", `${encodeURIComponent(name)}.json`)),
    });
  }
  const face = registryFace(registryUrl);
  return Object.freeze({
    registry: face,
    receiptBytes: async () => responseBytes(
      await fetchWithRetry(fetchImplementation, new URL("registry-receipt.json", face)),
      "registry face refused its receipt",
    ),
    packumentBytes: async (name) => responseBytes(
      await fetchWithRetry(fetchImplementation, new URL(encodeURIComponent(name), face)),
      `registry face refused a packument request for ${name}`,
    ),
  });
}

export function parseNpmRegistryObject(bytes, description) {
  if (bytes === null) return null;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected a JSON object");
    return value;
  } catch (cause) {
    throw new Error(`${description} is not a valid JSON object`, { cause });
  }
}

export async function readNpmRegistryReceipt(registry) {
  const bytes = await registry.receiptBytes();
  return bytes === null ? null : Object.freeze({ bytes, value: parseNpmRegistryObject(bytes, "registry receipt") });
}

export async function readNpmPackument(registry, name) {
  if (typeof name !== "string" || name.length === 0) throw new TypeError("name is required");
  const bytes = await registry.packumentBytes(name);
  return bytes === null ? null : Object.freeze({ bytes, value: parseNpmRegistryObject(bytes, `packument for ${name}`) });
}

export async function readNpmRegistryRelease(registry, { name, version } = {}) {
  const document = await readNpmPackument(registry, name);
  if (document === null) return Object.freeze({ document: null, version: version ?? null, manifest: null });
  const selected = version ?? document.value["dist-tags"]?.latest;
  const manifest = selected === undefined ? undefined : document.value.versions?.[selected];
  if (manifest !== undefined && (document.value.name !== name || manifest.name !== name || manifest.version !== selected)) {
    throw new Error(`package metadata identity does not match the requested package: ${name}@${selected}`);
  }
  return Object.freeze({ document, version: selected ?? null, manifest: manifest ?? null });
}
