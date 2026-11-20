import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

// Original native npm wire admission, shared by filesystem and R2 receiving.
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const tarballName = (url) => decodeURIComponent(new URL(url).pathname.split("/").pop());

export const admittedName = (name) => typeof name === "string" && name !== "" && !name.startsWith("-")
  && !name.includes("..") && !/[\\\u0000-\u001f\u007f]/u.test(name)
  && (name.startsWith("@") ? /^@[^/]+\/[^/]+$/u.test(name) : !name.includes("/"));

export function parsePackagePath(pathname) {
  const path = decodeURIComponent(pathname).replace(/^\/+/u, "");
  const parts = path.split("/");
  const nameLength = parts[0]?.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  return { name, rest: parts.slice(nameLength) };
}

const versionIdentity = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const measured = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

/** A package.json `repository` (any npm form: a URL, {url}, github:owner/name, owner/name) as owner/name, or null. */
export function repositoryOf(reference) {
  const value = typeof reference === "string" ? reference : reference?.url;
  if (typeof value !== "string") return null;
  const match = /^(?:git\+)?(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com[/:]|git@github\.com:|github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(value.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

// npm's publish wire format names scoped attachments with the full package
// name; the store's leaf uses a filename. Normalize that representation once
// here, before any write, and bind every manifest to it.
export function admittedPublication(name, body, state) {
  if (body?.name !== name || !record(body.versions) || Object.keys(body.versions).length === 0 || !record(body._attachments)) throw new TypeError("a publish names its package, versions, and attached artifacts");
  if (body["dist-tags"] !== undefined && !record(body["dist-tags"])) throw new TypeError("dist-tags must map tags to published versions");
  const artifacts = new Map(), manifests = new Map(), used = new Set();
  for (const [version, manifest] of Object.entries(body.versions)) {
    if (!versionIdentity.test(version) || !record(manifest) || manifest.name !== name || manifest.version !== version || !record(manifest.dist)) throw new TypeError("each version manifest must carry its exact package and version identity");
    // Repository provenance is retained verbatim. Source-publication policy is
    // enforced by the originating producer, not by the npm wire codec.
    const file = `${name.split("/").pop()}-${version}.tgz`;
    let advertised;
    try { advertised = tarballName(manifest.dist.tarball); }
    catch { throw new TypeError("each version must name its attached tarball"); }
    if (advertised !== file) throw new TypeError("version tarball path does not identify its canonical artifact");
    const keys = [...new Set([file, `${name}-${version}.tgz`])].filter(key => Object.hasOwn(body._attachments, key));
    if (keys.length !== 1) throw new TypeError("each version must identify exactly one attached artifact");
    const key = keys[0], attachment = body._attachments[key];
    if (!record(attachment) || typeof attachment.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(attachment.data)) throw new TypeError("artifact data must be canonical base64");
    const bytes = Buffer.from(attachment.data, "base64");
    if (bytes.toString("base64") !== attachment.data) throw new TypeError("artifact data must be canonical base64");
    if (!Number.isSafeInteger(attachment.length) || attachment.length !== bytes.length) throw new TypeError("artifact length does not match its bytes");
    const shasum = measured("sha1", bytes, "hex"), integrity = `sha512-${measured("sha512", bytes, "base64")}`;
    if (manifest.dist.shasum !== undefined && manifest.dist.shasum !== shasum) throw new TypeError("artifact shasum does not match its bytes");
    if (manifest.dist.integrity !== undefined && manifest.dist.integrity !== integrity) throw new TypeError("artifact integrity does not match its bytes");
    if (manifest.dist.shasum === undefined && manifest.dist.integrity === undefined) throw new TypeError("artifact needs a declared integrity measurement");
    used.add(key); artifacts.set(file, bytes);
    const { tarball, ...dist } = manifest.dist;
    manifests.set(version, { ...manifest, dist: { ...dist, shasum, integrity } });
  }
  if (Object.keys(body._attachments).some(key => !used.has(key))) throw new TypeError("publication contains an artifact not bound to a version");
  for (const [tag, version] of Object.entries(body["dist-tags"] ?? {})) {
    if (!tag || tag.includes("/") || typeof version !== "string" || (!manifests.has(version) && !state.versions.has(version))) throw new TypeError("dist-tag must identify a published version");
  }
  return { artifacts, manifests };
}
