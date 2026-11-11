import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

/** R2's documented conditional-write contract with controllable failures. */
export class MemoryR2 {
  objects = new Map();
  calls = [];
  beforePut = null;
  afterPut = null;
  beforeDelete = null;
  afterDelete = null;
  snapshot(key, bytes, options = {}) {
    bytes = Buffer.from(bytes);
    return { key, bytes, size: bytes.length, etag: createHash("md5").update(bytes).digest("hex"),
      customMetadata: { ...options.customMetadata }, httpMetadata: { ...options.httpMetadata } };
  }
  seed(key, value, options = {}) { this.objects.set(key, this.snapshot(key, value, options)); }
  view(object, body) {
    if (!object) return null;
    const bytes = Buffer.from(object.bytes);
    return { key: object.key, size: bytes.length, etag: object.etag, httpEtag: '"' + object.etag + '"',
      customMetadata: { ...object.customMetadata }, httpMetadata: { ...object.httpMetadata },
      ...(body ? { body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => bytes.toString("utf8"), json: async () => JSON.parse(bytes.toString("utf8")) } : {}) };
  }
  async get(key) { this.calls.push({ method: "get", key }); return this.view(this.objects.get(key), true); }
  async head(key) { this.calls.push({ method: "head", key }); return this.view(this.objects.get(key), false); }
  async put(key, value, options = {}) {
    const bytes = Buffer.from(value);
    this.calls.push({ method: "put", key, options: structuredClone(options), bytes: bytes.length });
    if (this.beforePut) await this.beforePut(key, bytes, options);
    const old = this.objects.get(key), condition = options.onlyIf;
    if (condition?.etagDoesNotMatch === "*" && old) return null;
    if (condition?.etagMatches !== undefined && (!old || old.etag !== condition.etagMatches)) return null;
    const object = this.snapshot(key, bytes, options); this.objects.set(key, object);
    if (this.afterPut) await this.afterPut(key, bytes, options);
    return this.view(object, false);
  }
  async delete(key) {
    this.calls.push({ method: "delete", key });
    if (this.beforeDelete) await this.beforeDelete(key);
    this.objects.delete(key);
    if (this.afterDelete) await this.afterDelete(key);
  }
}
