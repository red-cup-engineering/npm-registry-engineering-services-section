import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
  const packumentPath = (name) => join(storage, name, "package.json");
  const locks = new Map();
  // Writes to one name happen one at a time, in arrival order.
  const exclusive = (name, work) => {
    const next = (locks.get(name) ?? Promise.resolve()).then(work, work);
    locks.set(name, next.catch(() => {}));
    return next;
  };

  const readJson = async (path) => {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  };
  const writeAtomic = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${process.pid}.${Date.now()}.partial`;
    await writeFile(partial, bytes);
    await rename(partial, path);
  };

  const tarballName = (url) => decodeURIComponent(new URL(url).pathname.split("/").pop());
  // What a client is shown: every tarball on this registry, and none of the store's own bookkeeping.
  function presented(name, packument) {
    const { _uplinks, _distfiles, _attachments, _rev, ...shown } = packument;
    const versions = {};
    for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
      const file = manifest.dist?.tarball ? tarballName(manifest.dist.tarball) : `${name.split("/").pop()}-${version}.tgz`;
      versions[version] = { ...manifest, dist: { ...manifest.dist, tarball: `${origin}/${name}/-/${file}` } };
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

  async function publish(name, body, user) {
    if (body?.name !== name || typeof body.versions !== "object") return refusal(400, "a publish names its package and carries its versions");
    return exclusive(name, async () => {
      const path = packumentPath(name);
      const stored = await readJson(path) ?? { name, versions: {}, time: {}, "dist-tags": {}, _attachments: {}, _distfiles: {}, _uplinks: {} };
      const at = now().toISOString();
      for (const version of Object.keys(body.versions)) {
        if (stored.versions[version]) return refusal(409, `${name}@${version} is already published; a version is never replaced`);
      }
      for (const [file, attachment] of Object.entries(body._attachments ?? {})) {
        const bytes = Buffer.from(attachment.data, "base64");
        await writeAtomic(join(storage, name, file), bytes);
        stored._attachments[file] = { shasum: createHash("sha1").update(bytes).digest("hex") };
      }
      for (const [version, manifest] of Object.entries(body.versions)) {
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
      if (!stored?.versions?.[version]) return refusal(404, `${name}@${version} is not published here`);
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
    const tag = /^\/-\/package\/(.+)\/dist-tags\/([^/]+)$/u.exec(url.pathname);
    if (tag) {
      const name = decodeURIComponent(tag[1]);
      if (method === "GET") return json((await packumentOf(name))?.["dist-tags"] ?? {});
      if (method !== "PUT") return refusal(405, "dist-tags are read or set");
      const user = await authenticated(request);
      if (!user) return refusal(401, "setting a dist-tag needs a publisher's credential");
      return setTag(name, decodeURIComponent(tag[2]), String(await request.json()));
    }
    if (url.pathname === "/" || url.pathname === "") return json({ registry: origin, privateScopes });
    const { name, rest } = parse(url.pathname);
    if (!name || name.startsWith("-") || name.includes("..")) return refusal(404, "not found");
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
