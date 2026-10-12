import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import bcrypt from "bcryptjs";

/**
 * The 561 Group's npm registry as a request handler: the npm registry protocol (packuments, tarballs,
 * publish, dist-tags, whoami, ping, audit) over a package store laid out as Verdaccio lays it out —
 * `<storage>/<name>/package.json` beside the name's tarballs — so the store it replaces is served as is.
 *
 * - A private name (one of `privateScopes`, or listed in `privateNames`) is held only here and never
 *   fetched from the uplink.
 * - Any other name is the uplink's (registry.npmjs.org): its packument is fetched when the cached copy
 *   is older than `uplinkMaxAgeMs` (the cached copy answers when the uplink cannot), and a tarball is
 *   fetched once and kept unless `cachePublicTarballs` is false. Installations
 *   can retain their own verified bytes without a second public binary cache.
 * - Publishing is Basic authentication against the htpasswd file the store already uses (bcrypt), the
 *   credential npm sends from `username`/`_password`. A version, once published, is never replaced.
 *
 * Every tarball URL is answered on `origin`, so clients only ever fetch from this registry.
 */
export function createNpmRegistry({
  storage, htpasswd, origin, privateScopes = [], privateNames = [],
  uplink = "https://registry.npmjs.org", uplinkMaxAgeMs = 10 * 60_000, cachePublicTarballs = true,
  fetch: fetchImpl = fetch, now = () => new Date(),
}) {
  if (typeof storage !== "string" || !storage) throw new TypeError("the registry needs its package storage directory");
  if (typeof origin !== "string" || !/^https?:\/\/[^/]+$/u.test(origin)) throw new TypeError("the registry's origin is a scheme and host, with no path");
  const upstream = uplink.replace(/\/+$/u, "");
  const isPrivate = (name) => privateNames.includes(name) || privateScopes.some((scope) => name.startsWith(`${scope}/`));
  // Every metadata route names the same bounded package path. Keep the
  // existing no-dot-segment/no-leading-dash admission, including on tag URLs.
  const admittedName = (name) => typeof name === "string" && name !== "" && !name.startsWith("-")
    && !name.includes("..") && !/[\\\u0000-\u001f\u007f]/u.test(name)
    && (name.startsWith("@") ? /^@[^/]+\/[^/]+$/u.test(name) : !name.includes("/"));
  const packumentPath = (name) => {
    if (!admittedName(name)) throw new TypeError("metadata requires one bounded package name");
    return join(storage, name, "package.json");
  };
  const locks = new Map();
  // This serving process owns the store. Publication and tag updates for one
  // name share one transaction queue; publishers never rewrite its files.
  const exclusive = (name, work) => {
    const next = (locks.get(name) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => {});
    locks.set(name, settled);
    settled.then(() => { if (locks.get(name) === settled) locks.delete(name); });
    return next;
  };

  const readJson = async (path) => {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  };
  const writeAtomic = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, bytes, { flag: "wx" });
      await rename(partial, path);
    } finally { await rm(partial, { force: true }); }
  };

  const readBytes = async (path) => {
    try { return await readFile(path); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  };
  // Unlike metadata replacement, an artifact is an immutable name. Link a
  // complete file into place without clobbering existing bytes, even when an
  // interrupted publication has already left the same artifact behind.
  const writeArtifact = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, bytes, { flag: "wx" });
      try { await link(partial, path); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (!(await readFile(path)).equals(bytes)) throw Object.assign(new Error("artifact already has different bytes"), { code: "ARTIFACT_CONFLICT" });
      }
    } finally { await rm(partial, { force: true }); }
  };

  const tarballName = (url) => decodeURIComponent(new URL(url).pathname.split("/").pop());
  function presentedManifest(name, version, manifest) {
    const file = manifest.dist?.tarball ? tarballName(manifest.dist.tarball) : `${name.split("/").pop()}-${version}.tgz`;
    return { ...manifest, dist: { ...manifest.dist, tarball: `${origin}/${name}/-/${file}` } };
  }
  // Packuments, exact versions and tags share the same served artifact identity.
  function presented(name, packument) {
    const { _uplinks, _distfiles, _attachments, _rev, ...shown } = packument;
    const versions = {};
    for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
      versions[version] = presentedManifest(name, version, manifest);
    }
    return { ...shown, versions };
  }

  async function fresh(path) {
    try { return now().getTime() - (await stat(path)).mtimeMs < uplinkMaxAgeMs; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  async function uplinkPackument(name) {
    const response = await fetchImpl(`${upstream}/${name.replace("/", "%2f")}`, { headers: { accept: "application/json" } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`uplink answered ${response.status} for ${name}`);
    return response.json();
  }

  /** The stored packument, refreshed from the uplink when the name is the uplink's and the copy is stale. */
  async function packumentOf(name) {
    const path = packumentPath(name);
    const local = await readJson(path);
    if (isPrivate(name) || (local && await fresh(path))) return local;
    let remote;
    try { remote = await uplinkPackument(name); }
    catch (error) { if (local) return local; throw error; }
    if (remote === null) return local;
    const distfiles = { ...(local?._distfiles ?? {}) };
    for (const manifest of Object.values(remote.versions ?? {})) {
      if (manifest.dist?.tarball) distfiles[tarballName(manifest.dist.tarball)] = { url: manifest.dist.tarball, sha: manifest.dist.shasum };
    }
    const cached = { ...remote, _distfiles: distfiles, _attachments: local?._attachments ?? {}, _uplinks: { npmjs: { fetched: now().getTime() } } };
    await exclusive(name, () => writeAtomic(path, JSON.stringify(cached, null, 2)));
    return cached;
  }

  async function tarball(name, file) {
    const path = join(storage, name, file);
    try { return await readFile(path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (isPrivate(name)) return null;
    const packument = await packumentOf(name);
    const source = packument?._distfiles?.[file]?.url;
    if (!source) return null;
    const response = await fetchImpl(source);
    if (!response.ok) throw new Error(`uplink answered ${response.status} for ${file}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = packument._distfiles[file].sha;
    if (expected && createHash("sha1").update(bytes).digest("hex") !== expected) throw new Error(`${file} from the uplink does not match its shasum`);
    if (cachePublicTarballs) await writeAtomic(path, bytes);
    return bytes;
  }

  let users;
  async function authenticated(request) {
    const header = request.headers.get("authorization") ?? "";
    const basic = /^Basic\s+(.+)$/iu.exec(header);
    if (!basic) return null;
    const [user, ...rest] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    const password = rest.join(":");
    users ??= Object.fromEntries((await readFile(htpasswd, "utf8")).split("\n").filter(Boolean).map((line) => line.split(":")).map(([who, hash]) => [who, hash]));
    const hash = users[user];
    if (!hash || !/^\$2[aby]\$/u.test(hash)) return null;
    return (await bcrypt.compare(password, hash.replace(/^\$2y\$/u, "$2a$"))) ? user : null;
  }

  const json = (value, status = 200) => Response.json(value, { status });
  const refusal = (status, error) => json({ error }, status);

  const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const versionIdentity = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
  const measured = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

  // npm's publish wire format names scoped attachments with the full package
  // name; Verdaccio's retained store uses a leaf filename. Normalize that
  // representation once here, before any write, and bind every manifest to it.
  function admittedPublication(name, body, stored) {
    if (body?.name !== name || !record(body.versions) || Object.keys(body.versions).length === 0 || !record(body._attachments)) throw new TypeError("a publish names its package, versions, and attached artifacts");
    if (body["dist-tags"] !== undefined && !record(body["dist-tags"])) throw new TypeError("dist-tags must map tags to published versions");
    const artifacts = new Map(), manifests = new Map(), used = new Set();
    for (const [version, manifest] of Object.entries(body.versions)) {
      if (!versionIdentity.test(version) || !record(manifest) || manifest.name !== name || manifest.version !== version || !record(manifest.dist)) throw new TypeError("each version manifest must carry its exact package and version identity");
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
      manifests.set(version, { ...manifest, dist: { ...manifest.dist, shasum, integrity, tarball: `${origin}/${name}/-/${file}` } });
    }
    if (Object.keys(body._attachments).some(key => !used.has(key))) throw new TypeError("publication contains an artifact not bound to a version");
    for (const [tag, version] of Object.entries(body["dist-tags"] ?? {})) {
      if (!tag || tag.includes("/") || typeof version !== "string" || (!manifests.has(version) && !Object.hasOwn(stored.versions ?? {}, version))) throw new TypeError("dist-tag must identify a published version");
    }
    return { artifacts, manifests };
  }

  async function publish(name, body, user) {
    return exclusive(name, async () => {
      const path = packumentPath(name);
      const stored = await readJson(path) ?? { name, versions: {}, time: {}, "dist-tags": {}, _attachments: {}, _distfiles: {}, _uplinks: {} };
      if (record(body?.versions)) for (const version of Object.keys(body.versions)) {
        if (Object.hasOwn(stored.versions ?? {}, version)) return refusal(409, `${name}@${version} is already published; a version is never replaced`);
      }
      let admitted;
      try { admitted = admittedPublication(name, body, stored); }
      catch (error) { if (error instanceof TypeError) return refusal(400, error.message); throw error; }
      // Validate the complete transaction against occupied artifact names before
      // writing anything. A later interrupted write may leave unadvertised bytes,
      // but never alters a prior artifact or advertises an incomplete one.
      for (const [file, bytes] of admitted.artifacts) {
        const existing = await readBytes(join(storage, name, file));
        if (existing !== undefined && !existing.equals(bytes)) return refusal(409, `${file} already has different bytes`);
      }
      try {
        for (const [file, bytes] of admitted.artifacts) await writeArtifact(join(storage, name, file), bytes);
      } catch (error) { if (error.code === "ARTIFACT_CONFLICT") return refusal(409, error.message); throw error; }
      const at = now().toISOString();
      stored.versions ??= {}; stored.time ??= {}; stored._attachments ??= {};
      for (const [file, bytes] of admitted.artifacts) stored._attachments[file] = { shasum: measured("sha1", bytes, "hex") };
      for (const [version, manifest] of admitted.manifests) {
        stored.versions[version] = { ...manifest, _npmUser: { name: user } };
        stored.time[version] = at;
      }
      stored.time.created ??= at;
      stored.time.modified = at;
      stored["dist-tags"] = { ...stored["dist-tags"], ...(body["dist-tags"] ?? {}) };
      if (body.readme) stored.readme = body.readme;
      await writeAtomic(path, JSON.stringify(stored, null, 2));
      return json({ ok: "created new package", success: true }, 201);
    });
  }

  async function setTag(name, tag, version) {
    return exclusive(name, async () => {
      const path = packumentPath(name);
      const stored = await readJson(path);
      if (!Object.hasOwn(stored?.versions ?? {}, version)) return refusal(404, `${name}@${version} is not published here`);
      stored["dist-tags"] = { ...stored["dist-tags"], [tag]: version };
      stored.time = { ...stored.time, modified: now().toISOString() };
      await writeAtomic(path, JSON.stringify(stored, null, 2));
      return json({ ok: "dist-tag set" }, 201);
    });
  }

  // "/@scope%2fname", "/@scope/name" and "/name" are one name; "/<name>/-/<file>" is one of its tarballs.
  function parse(pathname) {
    const path = decodeURIComponent(pathname).replace(/^\/+/u, "");
    const parts = path.split("/");
    const nameLength = parts[0]?.startsWith("@") ? 2 : 1;
    const name = parts.slice(0, nameLength).join("/");
    return { name, rest: parts.slice(nameLength) };
  }

  /** Answer one request; every request reaching it is the registry's. */
  async function handle(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (url.pathname === "/-/ping") return json({});
    if (url.pathname === "/-/whoami") {
      const user = await authenticated(request);
      return user ? json({ username: user }) : refusal(401, "not signed in");
    }
    if (url.pathname.startsWith("/-/npm/v1/security/")) {
      const forwarded = await fetchImpl(`${upstream}${url.pathname}${url.search}`, { method, headers: { "content-type": request.headers.get("content-type") ?? "application/json", ...(request.headers.get("content-encoding") ? { "content-encoding": request.headers.get("content-encoding") } : {}) }, body: method === "GET" ? undefined : await request.arrayBuffer() });
      return new Response(forwarded.body, { status: forwarded.status, headers: { "content-type": forwarded.headers.get("content-type") ?? "application/json" } });
    }
    const tag = /^\/-\/package\/(.+)\/dist-tags(?:\/([^/]+))?$/u.exec(url.pathname);
    if (tag) {
      let name, selected;
      try {
        name = decodeURIComponent(tag[1]);
        selected = tag[2] === undefined ? undefined : decodeURIComponent(tag[2]);
      }
      catch { return refusal(400, "invalid package path encoding"); }
      if (!admittedName(name)) return refusal(404, "not found");
      if (method === "GET" || method === "HEAD") {
        const tags = (await packumentOf(name))?.["dist-tags"] ?? {};
        if (selected === undefined) return json(tags);
        return Object.hasOwn(tags, selected) ? json(tags[selected]) : refusal(404, "dist-tag not found");
      }
      if (method !== "PUT" || tag[2] === undefined) return refusal(405, "dist-tags are read or set");
      const user = await authenticated(request);
      if (!user) return refusal(401, "setting a dist-tag needs a publisher's credential");
      return setTag(name, selected, String(await request.json()));
    }
    if (url.pathname === "/" || url.pathname === "") return json({ registry: origin, privateScopes });
    let parsed;
    try { parsed = parse(url.pathname); }
    catch { return refusal(400, "invalid package path encoding"); }
    const { name, rest } = parsed;
    if (!admittedName(name)) return refusal(404, "not found");
    if (rest.length === 0) {
      if (method === "GET" || method === "HEAD") {
        const packument = await packumentOf(name);
        return packument ? json(presented(name, packument)) : refusal(404, `${name} is not in this registry`);
      }
      if (method === "PUT") {
        const user = await authenticated(request);
        if (!user) return refusal(401, "publishing needs a publisher's credential");
        if (!isPrivate(name)) return refusal(403, `${name} is not a house package name`);
        return publish(name, await request.json(), user);
      }
      return refusal(405, "a package is read or published");
    }
    if (rest.length === 1 && (method === "GET" || method === "HEAD")) {
      const packument = await packumentOf(name), selector = rest[0];
      const version = Object.hasOwn(packument?.versions ?? {}, selector) ? selector
        : Object.hasOwn(packument?.["dist-tags"] ?? {}, selector) ? packument["dist-tags"][selector] : undefined;
      return version !== undefined && Object.hasOwn(packument.versions ?? {}, version)
        ? json(presentedManifest(name, version, packument.versions[version])) : refusal(404, `${name}@${selector} is not in this registry`);
    }
    if (rest[0] === "-" && rest.length === 2 && (method === "GET" || method === "HEAD")) {
      const file = rest[1];
      if (!file.endsWith(".tgz") || file.includes("/")) return refusal(404, "not found");
      const bytes = await tarball(name, file);
      return bytes ? new Response(bytes, { headers: { "content-type": "application/octet-stream" } }) : refusal(404, `${file} is not in this registry`);
    }
    return refusal(404, "not found");
  }

  return Object.freeze({ handle });
}
