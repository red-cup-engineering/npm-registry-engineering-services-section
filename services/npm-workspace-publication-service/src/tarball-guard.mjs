import { execFile } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * No artifact may carry credentials onto the shelf. The registry is made to
 * be copied from; a private key inside a tarball is published the moment the
 * tarball is, however local the registry. Paths are judged by name here and
 * the publish scripts judge flagged .pem/.key contents before refusing, so a
 * public certificate chain can still ship while key material never does.
 */
// Executable source implements secret handling without itself being a secret
// carrier. Its bytes still pass the private-key and token content inspection.
export const SECRET_PATH = /(?!.*\.[cm]?[jt]s$)(^|\/)(\.env(\.(?!example$)[^/]*)?|[^/]*\.pem|[^/]*\.p12|[^/]*\.pfx|id_rsa[^/]*|id_ed25519[^/]*|[^/]*secret(?!ary)[^/]*|[^/]*credential[^/]*\.(json|ya?ml|env)|[^/]*private-key[^/]*|[^/]*keystore[^/]*)$/i;

/** List the files `npm pack` would ship from a package directory. */
export async function packedFiles(dir) {
  const pack = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: dir,
    maxBuffer: 1024 * 1024 * 64,
    timeout: 15_000,
    killSignal: "SIGTERM",
  });
  return (JSON.parse(pack.stdout)[0]?.files ?? []).map((file) => file.path);
}

/** Returns the packed paths that look like credential carriers ([] = clean). */
export async function secretBearingPaths(dir) {
  return Object.freeze((await packedFiles(dir)).filter((path) => SECRET_PATH.test(path)));
}

const PRIVATE_PEM = /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY|ENCRYPTED PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu;
const HIGH_CONFIDENCE_TOKEN = /(?:npm_[A-Za-z0-9]{36}|gh[opusr]_[A-Za-z0-9]{36,})/u;

function privateJson(value) {
  if (Array.isArray(value)) return value.some(privateJson);
  if (value === null || typeof value !== "object") return false;
  if (value.type === "service_account" && typeof value.private_key === "string" && privatePem(value.private_key)) return true;
  if (value.kty === "oct" && typeof value.k === "string" && /^[A-Za-z0-9_-]{16,}$/u.test(value.k)) return true;
  if (typeof value.kty === "string" && typeof value.d === "string") {
    try { createPrivateKey({ key: value, format: "jwk" }); return true; }
    catch { /* A field called d is not sufficient evidence of private-key material. */ }
  }
  return Object.values(value).some(privateJson);
}

function privatePem(text) {
  for (const match of text.matchAll(PRIVATE_PEM)) {
    if (match[1] === "ENCRYPTED PRIVATE KEY") return true;
    try { createPrivateKey(match[0]); return true; }
    catch { /* Documentation and test literals may deliberately resemble PEM. */ }
  }
  return false;
}

/**
 * The npm client publishing to this registry (observed: npm 11.17.0 against
 * Verdaccio 6.9.2) self-reports a `dist.tarball` URL that duplicates the full
 * scoped package name a second time after the `/-/` separator, e.g.
 * `.../@scope/name/-/@scope/name-1.0.0.tgz` where Verdaccio actually serves
 * (and the attachment is actually stored under) `.../@scope/name/-/name-1.0.0.tgz`.
 * This is a defect in what the npm client embeds in the publish payload, not
 * in this tool or in Verdaccio itself — Verdaccio faithfully stores whatever
 * `dist.tarball` string the client sent. Returns the corrected URL, or null
 * when `tarballURL` does not exhibit this exact corruption.
 */
export function correctedTarballURL(tarballURL, name) {
  if (typeof tarballURL !== "string" || tarballURL === "" || typeof name !== "string" || name === "") return null;
  const marker = `/-/${name}-`;
  const at = tarballURL.indexOf(marker);
  if (at === -1) return null;
  const leaf = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  const corrected = `${tarballURL.slice(0, at)}/-/${leaf}-${tarballURL.slice(at + marker.length)}`;
  // Unscoped names have leaf === name, so an already-correct unscoped URL
  // matches `marker` too; only report a change when one is truly needed.
  return corrected === tarballURL ? null : corrected;
}

/** Inspect the exact final packlist bytes, including lifecycle-generated files. */
export async function secretBearingContentPaths(dir, packedPaths = null) {
  const paths = packedPaths ?? await packedFiles(dir);
  const leaking = [];
  const carrierRoot = await realpath(resolve(dir));
  for (const carrierPath of paths) {
    const canonical = await realpath(resolve(carrierRoot, carrierPath));
    const local = relative(carrierRoot, canonical);
    if (local.startsWith("..") || isAbsolute(local)) {
      leaking.push(carrierPath);
      continue;
    }
    const bytes = await readFile(canonical);
    const text = bytes.toString("utf8");
    if (privatePem(text) || HIGH_CONFIDENCE_TOKEN.test(text)) {
      leaking.push(carrierPath);
      continue;
    }
    try { if (privateJson(JSON.parse(text))) leaking.push(carrierPath); }
    catch { /* Most carrier members are not JSON. */ }
  }
  return Object.freeze(leaking);
}
