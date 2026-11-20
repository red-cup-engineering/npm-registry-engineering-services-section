import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { internals } from "@red-cup-engineering/cloudflare-r2-engineering-services-section/r2-sigv4";

/**
 * The R2 bucket binding r2-registry.mjs uses (get, head, put with onlyIf, delete), served over R2's S3 API so the
 * same publication code runs in Node, outside the Worker's CPU bound. Conditional writes keep R2's semantics:
 * etagDoesNotMatch "*" is If-None-Match: *, etagMatches is If-Match, and a refused condition (412) is null.
 *
 * S3 lower-cases custom metadata names; `metadataNames` restores the names the registry writes, so an object
 * written here reads back exactly as one written through the Worker binding.
 */
const METADATA_NAMES = ["name", "version", "publisher", "inputSha256", "receivedAt", "integrity"];

export function createR2S3Bucket({ accountId, bucket, accessKeyId, secretAccessKey, fetchImpl = fetch, clock = () => new Date(),
  metadataNames = METADATA_NAMES }) {
  for (const [name, value] of Object.entries({ accountId, bucket, accessKeyId, secretAccessKey }))
    if (typeof value !== "string" || value === "") throw new TypeError("R2 S3 bucket needs " + name);
  const origin = `https://${accountId}.r2.cloudflarestorage.com`, host = new URL(origin).host;
  const named = new Map(metadataNames.map(name => [name.toLowerCase(), name]));
  const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

  async function request(method, key, { body, headers = {} } = {}) {
    const path = internals.canonicalPath(bucket, key), now = clock();
    const payloadHash = body === undefined ? internals.EMPTY_SHA256 : sha256(body);
    const signed = Object.fromEntries(Object.entries({ host, "x-amz-content-sha256": payloadHash,
      "x-amz-date": now.toISOString().replace(/[:-]|\.\d{3}/gu, ""), ...headers })
      .filter(([, value]) => value !== undefined).map(([name, value]) => [name.toLowerCase(), String(value)]));
    const auth = internals.authorization({ accessKeyId, secretAccessKey, method, path, headers: signed, payloadHash, now });
    return fetchImpl(origin + path, { method, headers: { ...signed, authorization: auth.value }, ...(body === undefined ? {} : { body }) });
  }
  function view(key, response, bytes) {
    const etag = (response.headers.get("etag") ?? "").replace(/^W\//u, "").replace(/^"|"$/gu, "");
    const customMetadata = {};
    for (const [header, value] of response.headers)
      if (header.startsWith("x-amz-meta-")) {
        const name = header.slice("x-amz-meta-".length);
        customMetadata[named.get(name) ?? name] = value;
      }
    const size = bytes ? bytes.length : Number(response.headers.get("content-length"));
    return { key, size, etag, httpEtag: '"' + etag + '"', customMetadata,
      httpMetadata: { contentType: response.headers.get("content-type") ?? undefined },
      ...(bytes ? { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => bytes.toString("utf8"), json: async () => JSON.parse(bytes.toString("utf8")) } : {}) };
  }
  async function refused(method, key, response) {
    const detail = method === "HEAD" ? "" : (await response.text()).slice(0, 300);
    throw Object.assign(new Error(`R2 ${method} ${key} refused (${response.status})${detail ? ": " + detail : ""}`), { r2Status: response.status });
  }

  return Object.freeze({
    async get(key) {
      const response = await request("GET", key, { headers: { "accept-encoding": "identity" } });
      if (response.status === 404) return null;
      if (!response.ok) await refused("GET", key, response);
      return view(key, response, Buffer.from(await response.arrayBuffer()));
    },
    async head(key) {
      // Without identity encoding R2 may answer a compressible object's HEAD with no or zero content-length.
      const response = await request("HEAD", key, { headers: { "accept-encoding": "identity" } });
      if (response.status === 404) return null;
      if (!response.ok) await refused("HEAD", key, response);
      return view(key, response, null);
    },
    async put(key, value, { onlyIf, httpMetadata = {}, customMetadata = {} } = {}) {
      const bytes = Buffer.from(typeof value === "string" ? Buffer.from(value) : value);
      if (onlyIf && Object.keys(onlyIf).some(name => !["etagDoesNotMatch", "etagMatches"].includes(name)))
        throw new TypeError("R2 S3 bucket admits only etagDoesNotMatch and etagMatches conditions");
      if (onlyIf?.etagDoesNotMatch !== undefined && onlyIf.etagDoesNotMatch !== "*")
        throw new TypeError("R2 S3 bucket admits etagDoesNotMatch only as *");
      const headers = { "content-length": bytes.length, "content-type": httpMetadata.contentType,
        "cache-control": httpMetadata.cacheControl,
        ...(onlyIf?.etagDoesNotMatch === "*" ? { "if-none-match": "*" } : {}),
        ...(onlyIf?.etagMatches !== undefined ? { "if-match": '"' + onlyIf.etagMatches + '"' } : {}) };
      for (const [name, value] of Object.entries(customMetadata)) headers["x-amz-meta-" + name.toLowerCase()] = value;
      const response = await request("PUT", key, { body: bytes, headers });
      if (response.status === 412) return null;
      if (!response.ok) await refused("PUT", key, response);
      const etag = (response.headers.get("etag") ?? "").replace(/^"|"$/gu, "");
      return { key, size: bytes.length, etag, httpEtag: '"' + etag + '"', customMetadata: { ...customMetadata }, httpMetadata: { ...httpMetadata } };
    },
    async delete(key) {
      const response = await request("DELETE", key);
      if (!response.ok && response.status !== 404) await refused("DELETE", key, response);
    },
  });
}
