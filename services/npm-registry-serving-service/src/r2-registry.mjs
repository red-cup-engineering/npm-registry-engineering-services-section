import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { admittedName, admittedPublication, parsePackagePath } from "./prepared-publication.mjs";
import { checkPublication, DEFAULT_HOUSE_SCOPES } from "./publish-gate.mjs";
import { registryIdentityConservation } from "./registry-identity-conservation.mjs";


const CUSTODY = "-/publication-inputs/";
const POLICY = "native-authenticated-house-publishers-v1";
const DEFAULT_UPLINK = "https://registry.npmjs.org";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (algorithm, bytes, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const integrityOf = bytes => "sha512-" + digest("sha512", bytes, "base64");
/** A package path as the public registry spells it: each segment encoded, a scope's @ kept. */
const uplinkPath = segments => "/" + segments.flatMap(part => part.split("/")).map(part => encodeURIComponent(part).replace(/^%40/u, "@")).join("/");
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers });

class Refusal extends Error {
  constructor(status, message, fields = {}, headers = {}) {
    super(message); this.status = status; this.fields = fields; this.headers = headers;
  }
}

function configurationOf(input) {
  if (!record(input) || typeof input.origin !== "string" || new URL(input.origin).origin !== input.origin
      || !input.origin.startsWith("https://") || !Array.isArray(input.privateScopes)
      || !Array.isArray(input.privateNames) || input.nativePublisherPolicy !== POLICY)
    throw new TypeError("R2 registry needs its source-qualified origin, house names and native publishing policy");
  if (input.privateScopes.some(scope => typeof scope !== "string" || !/^@[a-z0-9._-]+$/u.test(scope))
      || input.privateNames.some(name => !admittedName(name)))
    throw new TypeError("R2 house names do not match the admitted native namespace");
  const hold = input.publicationHold;
  if (hold !== undefined && (!record(hold) || Object.keys(hold).length !== 3
      || hold.type !== "RegistryIdentityConservationHold" || !/^[a-f0-9]{64}$/u.test(hold.recordSha256)
      || typeof hold.work !== "string" || !hold.work.startsWith("https://github.com/")))
    throw new TypeError("publication hold needs its typed original conservation record");
  if (Object.hasOwn(input, "conservationRelease"))
    throw new TypeError("conservationRelease is retired; finish the original conservation before ordinary publication");
  const bounds = {
    maxPublishBytes: input.maxPublishBytes ?? 8 * 1024 * 1024,
    maxMetadataBytes: input.maxMetadataBytes ?? 8 * 1024 * 1024,
    maxUnpackedBytes: input.maxUnpackedBytes ?? 16 * 1024 * 1024,
    authenticationTimeoutMs: input.authenticationTimeoutMs ?? 10_000,
    uplinkTimeoutMs: input.uplinkTimeoutMs ?? 60_000,
  };
  for (const [name, value] of Object.entries(bounds))
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(name + " is not an admitted resource bound");
  const uplink = input.uplink ?? DEFAULT_UPLINK;
  if (typeof uplink !== "string" || new URL(uplink).origin !== uplink || !uplink.startsWith("https://") || uplink === input.origin)
    throw new TypeError("the public uplink is another https registry origin");
  return Object.freeze({ ...input, ...bounds, uplink, privateScopes: [...input.privateScopes], privateNames: [...input.privateNames] });
}

async function boundedBytes(stream, limit, declared) {
  if (declared !== null && declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > limit))
    throw new Refusal(413, "request body exceeds its admitted byte bound");
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader(), chunks = []; let size = 0, ended = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { ended = true; break; }
      size += part.value.byteLength;
      if (size > limit) throw new Refusal(413, "request body exceeds its admitted byte bound");
      chunks.push(Buffer.from(part.value));
    }
  } finally { if (!ended) await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function readJson(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Refusal(400, label + " is not UTF-8 JSON"); }
}

function unchanged(request, etag) {
  const value = request.headers.get("if-none-match");
  if (value === null) return false;
  return value.split(",").some(tag => tag.trim() === "*" || tag.trim().replace(/^W\//u, "") === etag);
}

function sameSecret(value, expected) {
  if (typeof expected !== "string" || !expected) return false;
  const a = Buffer.from(value), b = Buffer.from("Bearer " + expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A registry document with every URL under one origin moved to another, streamed: the document is never parsed or held,
 * so a multi-megabyte packument costs the Worker one pass of string search. A match cut by a chunk boundary is carried
 * to the next chunk (or the end), and a character is never cut apart.
 */
export function rewriteOrigin(body, from, to) {
  const needle = from + "/", replacement = to + "/", decoder = new TextDecoder("utf-8"), encoder = new TextEncoder();
  let carry = "";
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const text = carry + decoder.decode(chunk, { stream: true });
      let cut = Math.max(0, text.length - (needle.length - 1));
      const start = cut === 0 ? -1 : text.lastIndexOf(needle, cut - 1);
      if (start >= 0 && start + needle.length > cut) cut = start;
      if (cut > 0 && (text.charCodeAt(cut - 1) & 0xfc00) === 0xd800) cut -= 1;
      carry = text.slice(cut);
      if (cut > 0) controller.enqueue(encoder.encode(text.slice(0, cut).replaceAll(needle, replacement)));
    },
    flush(controller) {
      const rest = carry + decoder.decode();
      if (rest) controller.enqueue(encoder.encode(rest.replaceAll(needle, replacement)));
    },
  }));
}

/**
 * The existing npm registry's R2 storage profile. The native origin is authentication
 * only; house supplier reads and publication stay in R2, and public names are read
 * from the public npm registry (the uplink) directly.
 */
export function createR2Registry({ bucket, configuration, nativeFetch = fetch, uplinkFetch = fetch, publishToken }) {
  const config = configurationOf(configuration);
  if (!bucket || !["get", "put", "head", "delete"].every(name => typeof bucket[name] === "function"))
    throw new TypeError("R2 registry requires the original bucket binding");
  const conservation = registryIdentityConservation(config.identityConservation, config);
  const isPrivate = name => config.privateNames.includes(name) || config.privateScopes.some(scope => name.startsWith(scope + "/"));
  const metadataKey = name => name + "/index.json";
  const archiveKey = (name, file) => name + "/-/" + file;

  function refuseConflict(name, version) {
    const held = conservation.conflict(name, version);
    if (held) throw new Refusal(409, "package version is quarantined for conflicting immutable identities", { conflict: held });
  }

  async function metadata(name, served = true) {
    const object = await bucket.get(metadataKey(name));
    if (object === null) return null;
    if (!Number.isSafeInteger(object.size) || object.size > config.maxMetadataBytes)
      throw new Refusal(502, "stored metadata exceeds its qualified receiving bound");
    const bytes = await boundedBytes(object.body, config.maxMetadataBytes, object.size);
    let document;
    try { document = readJson(bytes, "stored metadata"); }
    catch { throw new Refusal(502, "stored package metadata is unreadable"); }
    if (!record(document) || document.name !== name || !record(document.versions)
        || (document["dist-tags"] !== undefined && !record(document["dist-tags"])))
      throw new Refusal(502, "stored package metadata has another identity or shape");
    const rawDocument = document, rawBytes = bytes;
    const projected = served ? conservation.project(name, document) : document;
    const changed = projected !== document;
    return { object, rawDocument, rawBytes, document: projected,
      bytes: changed ? Buffer.from(JSON.stringify(projected)) : bytes,
      etag: changed ? '"' + digest("sha256", Buffer.from(JSON.stringify(projected))) + '"'
        : object.httpEtag ?? '"' + object.etag + '"' };
  }

  async function native(request, { bodyLimit = config.maxPublishBytes, stripAuthorization = false } = {}) {
    if (new URL(request.url).origin !== config.origin) throw new Refusal(400, "request has another registry origin");
    const headers = new Headers(request.headers);
    if (stripAuthorization) { headers.delete("authorization"); headers.delete("cookie"); }
    let body;
    if (request.method !== "GET" && request.method !== "HEAD")
      body = await boundedBytes(request.body, bodyLimit, request.headers.get("content-length"));
    const reply = await nativeFetch(new Request(request.url, {
      method: request.method, headers, ...(body === undefined ? {} : { body }),
      redirect: "manual", signal: AbortSignal.timeout(config.authenticationTimeoutMs),
    }));
    if (!stripAuthorization && reply.status >= 300 && reply.status < 400) {
      await reply.body?.cancel();
      throw new Refusal(503, "native authentication redirect was refused");
    }
    return reply;
  }

  /**
   * A non-house read, answered by the public npm registry itself: the origin of the public names, never the native
   * origin (which is the house's identity service, and a second hop that adds nothing to a public read). The request
   * carries only what selects a representation, never credentials; the document is the uplink's, with its tarball URLs
   * moved to this registry so a client that resolved here downloads here; the status is the uplink's. An archive is
   * streamed through unchanged. Nothing public is written to R2.
   */
  async function uplinkRead(request, path, archive = false) {
    const method = request.method.toUpperCase();
    const headers = new Headers();
    for (const field of ["accept", "if-none-match", "if-modified-since"]) {
      const value = request.headers.get(field); if (value !== null) headers.set(field, value);
    }
    const ttl = archive ? 31_536_000 : 300;
    let reply;
    try {
      reply = await uplinkFetch(new Request(config.uplink + path, {
        method, headers, redirect: "manual", signal: AbortSignal.timeout(config.uplinkTimeoutMs),
        cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": ttl, "300-599": 0 } },
      }));
    } catch { throw new Refusal(504, "the public npm registry did not answer in time", {}, { "retry-after": "5" }); }
    const out = new Headers();
    for (const field of ["content-type", "etag", "last-modified", "cache-control", "location", "retry-after"]) {
      const value = reply.headers.get(field); if (value !== null) out.set(field, value);
    }
    const rewritten = !archive && method === "GET" && reply.body !== null && /json/iu.test(out.get("content-type") ?? "");
    if (!rewritten && !reply.headers.get("content-encoding") && reply.headers.get("content-length") !== null)
      out.set("content-length", reply.headers.get("content-length"));
    if (out.has("location")) out.set("location", out.get("location").replace(config.uplink + "/", config.origin + "/"));
    const body = method === "HEAD" || reply.status === 204 || reply.status === 304 ? null
      : rewritten ? rewriteOrigin(reply.body, config.uplink, config.origin) : reply.body;
    if (body === null) await reply.body?.cancel();
    return new Response(body, { status: reply.status, headers: out });
  }

  async function authorize(request, name) {
    const authorization = request.headers.get("authorization") ?? "";
    let publisher;
    if (sameSecret(authorization, publishToken)) publisher = "existing-r2-publisher";
    else {
      if (!/^(?:Basic|Bearer)\s+\S+$/iu.test(authorization))
        throw new Refusal(401, "publishing needs an existing publisher credential");
      const target = new URL("/-/whoami", config.origin);
      let reply;
      try {
        reply = await nativeFetch(new Request(target, {
          headers: { authorization, accept: "application/json" }, redirect: "manual",
          signal: AbortSignal.timeout(config.authenticationTimeoutMs),
        }));
      } catch { throw new Refusal(503, "native publisher authentication is unavailable", {}, { "retry-after": "30" }); }
      if (reply.status === 401 || reply.status === 403) throw new Refusal(401, "native publisher credential was refused");
      if (reply.status !== 200) throw new Refusal(503, "native publisher authentication is unread", {}, { "retry-after": "30" });
      const bytes = await boundedBytes(reply.body, 4096, reply.headers.get("content-length"));
      const identity = readJson(bytes, "native publisher identity");
      if (typeof identity?.username !== "string" || identity.username.length === 0 || identity.username.length > 128
          || /[\u0000-\u001f\u007f]/u.test(identity.username))
        throw new Refusal(503, "native publisher identity is not qualified");
      publisher = identity.username;
    }
    // The qualified native policy grants authenticated publishers only house names.
    // The identity response by itself never bypasses this source-owned rule.
    if (!isPrivate(name)) throw new Refusal(403, name + " is not an admitted house package name");
    return publisher;
  }

  async function storedArchive(name, file, expected) {
    const object = await bucket.get(archiveKey(name, file));
    if (object === null) return null;
    if (!Number.isSafeInteger(object.size) || object.size > config.maxPublishBytes)
      throw new Refusal(409, "existing immutable artifact exceeds this prepared profile");
    const bytes = await boundedBytes(object.body, config.maxPublishBytes, object.size);
    if (integrityOf(bytes) !== expected) throw new Refusal(409, "immutable artifact already has different bytes");
    return object;
  }

  async function retireInput(key, inputSha256, publisher) {
    const custody = { state: "retained", key, inputSha256 };
    try {
      const object = await bucket.get(key);
      if (object === null) return { ...custody, state: "retired" };
      const original = await boundedBytes(object.body, config.maxPublishBytes, object.size);
      const observedInputSha256 = digest("sha256", original);
      if (observedInputSha256 !== inputSha256 || object.customMetadata?.publisher !== publisher)
        return { state: "not-owned", key, requestedInputSha256: inputSha256, observedInputSha256 };
      await bucket.delete(key);
      if (await bucket.head(key) === null) return { ...custody, state: "retired" };
      return { ...custody, retirement: "not-received" };
    } catch { return { ...custody, retirement: "unreceived" }; }
  }

  async function publish(request, name, resume) {
    let custody = null, custodyAttempted = false;
    try {
      const publisher = await authorize(request, name);
      const type = request.headers.get("content-type") ?? "";
      if (!/^application\/json(?:\s*;|$)/iu.test(type)) throw new Refusal(415, "npm prepared publication is application/json");
      const encoded = await boundedBytes(request.body, config.maxPublishBytes, request.headers.get("content-length"));
      const body = readJson(encoded, "prepared publication");
      if (record(body?.versions) && body._attachments === undefined)
        throw new Refusal(405, "house deprecation or metadata changes require the canonical R2 CAS operation; no native shelf was changed");
      if (!record(body?.versions) || Object.keys(body.versions).length !== 1)
        throw new Refusal(400, "this npm prepared publication profile receives exactly one version");
      if (body._id !== undefined && body._id !== name) throw new Refusal(400, "publication id differs from its package");
      const [submittedVersion] = Object.keys(body.versions);
      if (resume && (resume.version !== submittedVersion || !/^[a-f0-9]{64}$/u.test(resume.inputSha256 ?? "")
          || digest("sha256", encoded) !== resume.inputSha256))
        throw new Refusal(400, "resume must select the exact original package/version/input bytes");
      if (config.publicationHold)
        throw new Refusal(423, "publication is held for immutable identity conservation", {
          publicationHold: config.publicationHold, effectsUnknown: false, custody: { state: "not-allocated" },
        });
      refuseConflict(name, submittedVersion);
      if (Object.hasOwn(body, "x-561-registry-conflicts"))
        throw new Refusal(400, "conflict evidence is an operator-derived view, not publication metadata");
      const reservation = conservation.reservation(name, submittedVersion);
      if (reservation && !conservation.matches(body.versions[submittedVersion], reservation.identity))
        throw new Refusal(409, "native version is reserved for its exact observed immutable product", { reservation });
      if (record(body["dist-tags"]))
        for (const selected of Object.values(body["dist-tags"])) refuseConflict(name, selected);
      // Conditional publication must preserve raw quarantined originals, never a served projection.
      const before = await metadata(name, false);
      let admitted;
      try { admitted = admittedPublication(name, body, { versions: new Map(Object.entries(before?.document.versions ?? {})) }); }
      catch (error) { throw new Refusal(400, error.message); }
      const [version, manifest] = admitted.manifests.entries().next().value;
      const file = name.split("/").pop() + "-" + version + ".tgz";
      const bytes = admitted.artifacts.get(file);
      // A reservation binds the complete historical manifest. Ordinary publication records
      // the authenticated publisher, as the native receiver does, never caller-supplied attribution.
      const published = { ...manifest, ...(reservation ? {} : { _npmUser: { name: publisher } }),
        dist: { ...manifest.dist, tarball: config.origin + "/" + archiveKey(name, file) } };
      if (reservation && !conservation.matches(published, reservation.identity))
        throw new Refusal(409, "native reservation cannot be transformed into another manifest", { reservation });
      const tags = body["dist-tags"] ?? {};
      const inputSha256 = digest("sha256", encoded);
      const inputKey = CUSTODY + name + "/" + version + ".json";
      if (resume) {
        const original = await bucket.get(inputKey);
        if (original !== null) {
          const actual = digest("sha256", await boundedBytes(original.body, config.maxPublishBytes, original.size));
          if (actual !== inputSha256 || original.customMetadata?.publisher !== publisher
              || original.customMetadata?.inputSha256 !== inputSha256)
            throw new Refusal(409, "continuation does not own the retained original publication input", {
              custody: { state: "not-owned", key: inputKey, requestedInputSha256: inputSha256, observedInputSha256: actual },
            });
          // Keep known original server custody visible even if a new gate
          // policy refuses continuation before another publication effect.
          custody = { state: "retained", key: inputKey, inputSha256 };
          custodyAttempted = true;
        }
      }
      const existing = before?.document.versions[version];
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing, published)) throw new Refusal(409, "published version already has another immutable manifest");
        if (!Object.entries(tags).every(([tag, selected]) => before.document["dist-tags"]?.[tag] === selected))
          throw new Refusal(409, "published version is received but requested tags differ; no tag rollback was made");
        if (!await storedArchive(name, file, published.dist.integrity)) throw new Refusal(409, "published artifact is absent");
        // Reconcile only a positively owned original input after complete
        // readback. No source, publication, claim allocation or tag replay.
        const pending = await bucket.head(inputKey);
        const receivedCustody = pending === null && !resume ? { state: "not-allocated" }
          : await retireInput(inputKey, inputSha256, publisher);
        return json({ ok: true, id: name, version, alreadyReceived: true, custody: receivedCustody });
      }
      const violations = await checkPublication({
        name, version, bytes,
        houseScopes: [...new Set([...DEFAULT_HOUSE_SCOPES, ...config.privateScopes])],
        // A same-zone fetch would read the old native shelf. Read canonical R2.
        publishedPackument: async supplier => (await metadata(supplier))?.document ?? null,
        publishedManifest: async (supplier, selected) => {
          if (conservation.conflict(supplier, selected)) return null;
          return (await metadata(supplier, false))?.document.versions[selected] ?? null;
        },
        maxUnpackedBytes: config.maxUnpackedBytes,
      });
      if (violations.length) throw new Refusal(400, "the existing publication gate refused the prepared archive", { violations });
      if (body.time !== undefined && !record(body.time)) throw new Refusal(400, "publication time is a metadata object");
      const now = new Date().toISOString();
      const { _attachments, versions, "dist-tags": _tags, _rev, time, ...fields } = body;
      const document = {
        ...(before?.document ?? {}), ...fields, name,
        versions: { ...(before?.document.versions ?? {}), [version]: published },
        "dist-tags": { ...(before?.document["dist-tags"] ?? {}), ...tags },
        time: { ...(before?.document.time ?? {}), ...(time ?? {}), [version]: now, modified: now },
      };
      document.time.created ??= now;
      const { _rev: previousRevision, ...revisionContent } = document;
      document._rev = "r2-" + digest("sha256", JSON.stringify(revisionContent));
      const metadataBytes = Buffer.from(JSON.stringify(document));
      if (metadataBytes.length > config.maxMetadataBytes) throw new Refusal(413, "merged metadata exceeds its qualified receiving bound");
      custody = { state: "claim-unreceived", key: inputKey, requestedInputSha256: inputSha256 };
      const occupied = resume ? await bucket.get(inputKey) : await bucket.head(inputKey);
      if (occupied !== null) {
        // Only the authenticated original publisher may continue these exact
        // retained bytes. Ordinary PUT still refuses an occupied input.
        if (!resume || occupied.customMetadata?.publisher !== publisher
            || occupied.customMetadata?.inputSha256 !== inputSha256
            || digest("sha256", await boundedBytes(occupied.body, config.maxPublishBytes, occupied.size)) !== inputSha256)
          throw new Refusal(409, "this package/version has another unresolved original publication input", {
            custody: { state: "not-owned", key: inputKey, requestedInputSha256: inputSha256,
              observedInputSha256: occupied.customMetadata?.inputSha256 ?? null },
          });
        custodyAttempted = true;
      } else {
        // Absence is not a claim of no in-flight effects. The original atomic
        // create-once claim arbitrates this continuation against every writer.
        custodyAttempted = true;
        const claimed = await bucket.put(inputKey, encoded, {
          onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
          customMetadata: { name, version, publisher, inputSha256, receivedAt: now },
        });
        if (claimed === null) {
          custodyAttempted = false;
          throw new Refusal(409, "another original input already owns this package/version", {
            custody: { state: "not-owned", key: inputKey, requestedInputSha256: inputSha256 },
          });
        }
      }
      const receivedInput = await bucket.get(inputKey);
      if (receivedInput === null || digest("sha256", await boundedBytes(receivedInput.body, config.maxPublishBytes, receivedInput.size)) !== inputSha256
          || receivedInput.customMetadata?.publisher !== publisher)
        throw new Refusal(502, "original publication input did not receive exact durable custody", { effectsUnknown: true });
      custody = { state: "retained", key: inputKey, inputSha256 };
      const heldArchive = await storedArchive(name, file, published.dist.integrity);
      if (heldArchive === null) {
        const placed = await bucket.put(archiveKey(name, file), bytes, {
          onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/octet-stream" },
          customMetadata: { integrity: published.dist.integrity },
        });
        if (placed === null) throw new Refusal(409, "immutable artifact creation raced another writer");
      }
      const written = await bucket.put(metadataKey(name), metadataBytes, {
        onlyIf: before ? { etagMatches: before.object.etag } : { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json", cacheControl: "no-cache" },
      });
      if (written === null) throw new Refusal(409, "metadata changed; original input and unadvertised artifact remain held");
      const received = await metadata(name);
      if (!received || !isDeepStrictEqual(received.document.versions[version], published)
          || !Object.entries(tags).every(([tag, selected]) => received.document["dist-tags"]?.[tag] === selected)
          || !await storedArchive(name, file, published.dist.integrity))
        throw new Refusal(502, "publication effects did not receive complete metadata and archive readback", { effectsUnknown: true });
      // This version is now immutable. Every later request for it exits above
      // without allocating/reusing this key, even while cleanup is delayed.
      custody = await retireInput(inputKey, inputSha256, publisher);
      return json({ ok: true, id: name, version, custody, effectsUnknown: false }, 201);
    } catch (error) {
      const fields = { ...(custodyAttempted ? { custody } : {}), ...(error.fields ?? {}) };
      if (!(error instanceof Refusal)) fields.effectsUnknown = custodyAttempted;
      return json({ error: error instanceof Refusal ? error.message : "the registry operation did not produce a qualified result", ...fields },
        error instanceof Refusal ? error.status : 502, error.headers ?? {});
    }
  }

  /** A version's archive file: the one its tarball URL names, else npm's canonical `name-version.tgz`. */
  const archiveFile = (name, version, manifest) => {
    try { if (typeof manifest?.dist?.tarball === "string") return decodeURIComponent(new URL(manifest.dist.tarball).pathname.split("/").pop()); }
    catch { /* not a URL: the canonical name below */ }
    return name.split("/").pop() + "-" + version + ".tgz";
  };

  /**
   * `npm unpublish`: remove versions of a house package with their archives, or the whole package when `offered` is
   * undefined. `offered` is the packument npm PUTs back less the removed versions; its dist-tags are kept where they
   * name a version left, and `latest` falls back to the most recently published version left. The metadata changes
   * first, conditionally, so no served document names an archive about to go.
   */
  async function unpublish(request, name, offered) {
    try {
      await authorize(request, name);
      const before = await metadata(name, false);
      if (!before) throw new Refusal(404, "package is not in this registry");
      const versions = Object.keys(before.document.versions);
      // A client's packument leaves quarantined versions out; leaving them out of its PUT does not remove them.
      const removed = versions.filter(version => offered === undefined
        || (!Object.hasOwn(offered.versions, version) && !conservation.conflict(name, version)));
      if (removed.length === 0) throw new Refusal(400, "the packument removes no version");
      if (removed.length === versions.length) await bucket.delete(metadataKey(name));
      else {
        const left = versions.filter(version => !removed.includes(version));
        const tags = Object.fromEntries(Object.entries({ ...before.document["dist-tags"], ...(record(offered["dist-tags"]) ? offered["dist-tags"] : {}) })
          .filter(([, version]) => left.includes(version)));
        const time = Object.fromEntries(Object.entries(before.document.time ?? {}).filter(([key]) => !removed.includes(key)));
        tags.latest ??= [...left].sort((a, b) => String(time[a] ?? "").localeCompare(String(time[b] ?? ""))).pop();
        const document = { ...before.document, versions: Object.fromEntries(left.map(version => [version, before.document.versions[version]])),
          "dist-tags": tags, time: { ...time, modified: new Date().toISOString() } };
        const { _rev: previousRevision, ...revisionContent } = document;
        document._rev = "r2-" + digest("sha256", JSON.stringify(revisionContent));
        const written = await bucket.put(metadataKey(name), Buffer.from(JSON.stringify(document)), {
          onlyIf: { etagMatches: before.object.etag },
          httpMetadata: { contentType: "application/json", cacheControl: "no-cache" },
        });
        if (written === null) throw new Refusal(409, "metadata changed while unpublishing; nothing was removed");
      }
      for (const version of removed) {
        await bucket.delete(archiveKey(name, archiveFile(name, version, before.document.versions[version])));
        await bucket.delete(CUSTODY + name + "/" + version + ".json");
      }
      const lingering = [];
      for (const version of removed) {
        const key = archiveKey(name, archiveFile(name, version, before.document.versions[version]));
        if (await bucket.head(key) !== null) lingering.push(key);
      }
      if (removed.length === versions.length && await bucket.head(metadataKey(name)) !== null) lingering.push(metadataKey(name));
      if (lingering.length) throw new Refusal(502, "unpublished objects are still held", { lingering });
      return json({ ok: true, id: name, removed });
    } catch (error) {
      return json({ error: error instanceof Refusal ? error.message : "the registry operation did not produce a qualified result", ...(error.fields ?? {}) },
        error instanceof Refusal ? error.status : 502, error.headers ?? {});
    }
  }

  async function fetchRequest(request) {
    try {
      if (new URL(request.url).origin !== config.origin) throw new Refusal(400, "request has another registry origin");
      const url = new URL(request.url), method = request.method.toUpperCase();
      let path;
      try { path = decodeURIComponent(url.pathname).replace(/^\/+/u, ""); }
      catch { throw new Refusal(400, "invalid package path encoding"); }
      if (path === CUSTODY.slice(0, -1) || path.startsWith(CUSTODY)) {
        const selected = /^-\/publication-inputs\/((?:@[^/]+\/)?[^/]+)\/([^/]+)\/resume$/u.exec(path);
        if (!selected || !admittedName(selected[1])) throw new Refusal(404, "not found");
        if (method !== "POST") throw new Refusal(405, "original publication continuation uses POST");
        return publish(request, selected[1], { version: selected[2], inputSha256: request.headers.get("x-561-input-sha256") });
      }
      if (path === "-/ping") return json({});
      if (path === "") return json({ registry: config.origin, privateScopes: config.privateScopes });
      if (path === "-/whoami" || path.startsWith("-/user/")) {
        const reply = await native(request, { bodyLimit: 64 * 1024 });
        const headers = new Headers(reply.headers); headers.set("cache-control", "no-store");
        return new Response(reply.body, { status: reply.status, headers });
      }
      if (path.startsWith("-/npm/v1/security/")) return native(request, { stripAuthorization: true });
      if (path === "-/v1/search")
        throw new Refusal(503, "canonical R2 house catalogue search is held; the native shelf is not a fresh R2 catalogue");
      const tag = /^-\/package\/(.+)\/dist-tags(?:\/([^/]+))?$/u.exec(path);
      if (tag) {
        const name = tag[1], selected = tag[2];
        if (!admittedName(name)) throw new Refusal(404, "not found");
        if (!isPrivate(name)) {
          if (method !== "GET" && method !== "HEAD") throw new Refusal(403, name + " is not an admitted house package name");
          return await uplinkRead(request, uplinkPath(["-", "package", name, "dist-tags", ...(selected === undefined ? [] : [selected])]));
        }
        if (method !== "GET" && method !== "HEAD") throw new Refusal(405, "house tag changes require the canonical R2 CAS publication path");
        const held = await metadata(name);
        if (!held) throw new Refusal(404, "package is not in this registry");
        const tags = held.document["dist-tags"] ?? {};
        if (selected !== undefined) refuseConflict(name, held.rawDocument["dist-tags"]?.[selected]);
        if (selected !== undefined && !Object.hasOwn(tags, selected)) throw new Refusal(404, "tag is not in this registry");
        return new Response(method === "HEAD" ? null : JSON.stringify(selected === undefined ? tags : tags[selected]),
          { headers: { "content-type": "application/json", "cache-control": "no-cache" } });
      }
      const parsed = parsePackagePath(url.pathname), name = parsed.name, rest = parsed.rest;
      if (!admittedName(name)) throw new Refusal(404, "not found");
      // npm unpublish: DELETE <name>/-rev/<rev> removes the package; PUT <name>/-rev/<rev> with the packument less some
      // versions removes those; DELETE <name>/-/<file>/-rev/<rev> then asks for a removed version's archive, already gone.
      if (method === "DELETE" || rest.includes("-rev")) {
        const revision = rest.indexOf("-rev");
        if (method === "DELETE" && revision === 0 && rest.length === 2) return unpublish(request, name);
        if (method === "PUT" && revision === 0 && rest.length === 2) {
          const body = readJson(await boundedBytes(request.body, config.maxMetadataBytes, request.headers.get("content-length")), "unpublish packument");
          if (!record(body) || body.name !== name || !record(body.versions))
            throw new Refusal(400, "an unpublish PUT is the package's packument less the versions it removes");
          return unpublish(request, name, body);
        }
        if (method === "DELETE" && rest[0] === "-" && revision === 2 && rest.length === 4) {
          if (!rest[1].endsWith(".tgz") || rest[1].startsWith(".") || rest[1].includes("\\")) throw new Refusal(404, "not found");
          await authorize(request, name);
          const held = await metadata(name, false);
          if (held && Object.entries(held.document.versions).some(([version, manifest]) => archiveFile(name, version, manifest) === rest[1]))
            throw new Refusal(409, rest[1] + " is a published version's archive; unpublish the version");
          await bucket.delete(archiveKey(name, rest[1]));
          return json({ ok: true, id: name });
        }
        throw new Refusal(405, "a package is unpublished at <name>/-rev/<rev>");
      }
      if (method === "PUT" && rest.length === 0) return publish(request, name);
      if (method !== "GET" && method !== "HEAD") throw new Refusal(405, "only standard npm prepared publication may write this registry");
      if (!isPrivate(name)) {
        const archive = rest.length === 2 && rest[0] === "-";
        if (rest.length > 2 || (rest.length === 2 && !archive)
            || (archive && (!rest[1].endsWith(".tgz") || rest[1].startsWith(".") || rest[1].includes("/") || rest[1].includes("\\"))))
          throw new Refusal(404, "not found");
        return await uplinkRead(request, uplinkPath([name, ...rest]), archive);
      }
      if (rest.length === 1) refuseConflict(name, rest[0]);
      if (rest[0] === "-" && rest.length === 2) {
        const file = rest[1];
        if (!file.endsWith(".tgz") || file.startsWith(".") || file.includes("/") || file.includes("\\"))
          throw new Refusal(404, "not found");
        const conflict = conservation.artifactConflict(name, file);
        if (conflict) refuseConflict(name, conflict.version);
        const object = await bucket.get(archiveKey(name, file));
        if (object === null) throw new Refusal(404, "artifact is not in this registry");
        const etag = object.httpEtag ?? '"' + object.etag + '"';
        if (unchanged(request, etag)) return new Response(null, { status: 304, headers: { etag } });
        return new Response(method === "HEAD" ? null : object.body, {
          headers: { etag, "content-type": "application/octet-stream", "content-length": String(object.size),
            "cache-control": "public, max-age=31536000, immutable" },
        });
      }
      if (rest.length > 1) throw new Refusal(404, "not found");
      // A packument nothing projects is served as the bytes this registry's own publication wrote and checked,
      // without parsing it: house packuments reach 1 to 2 MB, and parsing one costs the Worker's whole CPU bound.
      if (rest.length === 0 && !conservation.projects(name)) {
        const object = await bucket.get(metadataKey(name));
        if (object === null) throw new Refusal(404, "package is not in this registry");
        if (!Number.isSafeInteger(object.size) || object.size > config.maxMetadataBytes)
          throw new Refusal(502, "stored metadata exceeds its qualified receiving bound");
        const etag = object.httpEtag ?? '"' + object.etag + '"';
        if (unchanged(request, etag)) { await object.body?.cancel?.(); return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } }); }
        if (method === "HEAD") await object.body?.cancel?.();
        return new Response(method === "HEAD" ? null : object.body, {
          headers: { etag, "content-type": "application/json", "content-length": String(object.size), "cache-control": "no-cache" },
        });
      }
      const held = await metadata(name);
      if (held === null) throw new Refusal(404, "package is not in this registry");
      let bytes = held.bytes, etag = held.etag;
      if (rest.length === 1) {
        const selector = rest[0];
        const originalVersion = Object.hasOwn(held.rawDocument.versions, selector)
          ? selector : held.rawDocument["dist-tags"]?.[selector];
        refuseConflict(name, originalVersion);
        const version = Object.hasOwn(held.document.versions, selector) ? selector : held.document["dist-tags"]?.[selector];
        if (typeof version !== "string" || !Object.hasOwn(held.document.versions, version)) throw new Refusal(404, "version is not in this registry");
        bytes = Buffer.from(JSON.stringify(held.document.versions[version]));
        etag = '"' + digest("sha256", bytes) + '"';
      }
      if (unchanged(request, etag)) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });
      return new Response(method === "HEAD" ? null : bytes, {
        headers: { etag, "content-type": "application/json", "content-length": String(bytes.length), "cache-control": "no-cache" },
      });
    } catch (error) {
      return json({ error: error instanceof Refusal ? error.message : "registry receiving is unavailable" },
        error instanceof Refusal ? error.status : 502, error.headers ?? {});
    }
  }
  return Object.freeze({ fetch: fetchRequest });
}

/** The registry configuration from the Worker's plain-text bindings, shared by the Worker and the Node publication writer. */
export function workerConfiguration(env) {
  let configuration = JSON.parse(env.REGISTRY_CONFIGURATION);
  const conflicts = env.REGISTRY_IDENTITY_CONFLICTS, reservations = env.REGISTRY_IDENTITY_RESERVATIONS;
  if (conflicts !== undefined || reservations !== undefined) {
    if (typeof conflicts !== "string" || typeof reservations !== "string" || configuration.identityConservation !== undefined)
      throw new TypeError("split identity observations require both arrays and no embedded policy");
    configuration = { ...configuration, identityConservation: {
      version: 1, conflicts: JSON.parse(conflicts), reservations: JSON.parse(reservations),
    } };
  }
  return configuration;
}

export default {
  fetch(request, env) {
    return createR2Registry({ bucket: env.R, configuration: workerConfiguration(env), publishToken: env.PUBLISH_TOKEN }).fetch(request);
  },
};
