#!/usr/bin/env node
// Origin-side publisher for the canonical registry. R2 holds package metadata and
// publication transactions. In Guix mode this process registers and streams
// package archives through the Guix store.
//
// Environment (every specific is a parameter):
//   PORT                                  listening port on 127.0.0.1
//   REGISTRY_CONFIGURATION, REGISTRY_IDENTITY_CONFLICTS, REGISTRY_IDENTITY_RESERVATIONS
//                                         the Worker's plain-text bindings, verbatim
//   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//                                         the bucket the Worker binds as R, and an S3 credential for it
//   NATIVE_ORIGIN_URL                     native identity origin, e.g. http://127.0.0.1:18821
//   REGISTRY_ARCHIVE_AUTHORITY            r2 or guix
//   REGISTRY_GUIX_STATE                   durable receipt directory in Guix mode
//   REGISTRY_GUIX_ROOTS                   daemon-visible collector directory in Guix mode
//   REGISTRY_GUIX_PROGRAM                 optional Guix executable path
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createR2Registry, workerConfiguration } from "../src/r2-registry.mjs";
import { createR2S3Bucket } from "../src/r2-s3-bucket.mjs";
import { createGuixArchiveBucket } from "../src/guix-archive-bucket.mjs";
import { createGuixArchiveRegistrar } from "../src/guix-archive-registration.mjs";

const need = name => { const value = process.env[name]; if (!value) throw new TypeError(name + " is required"); return value; };
const configuration = workerConfiguration(process.env);
const origin = new URL(configuration.origin), nativeOrigin = new URL(need("NATIVE_ORIGIN_URL"));
const metadataBucket = createR2S3Bucket({ accountId: need("R2_ACCOUNT_ID"), bucket: need("R2_BUCKET"),
  accessKeyId: need("R2_ACCESS_KEY_ID"), secretAccessKey: need("R2_SECRET_ACCESS_KEY") });
const archiveAuthority = process.env.REGISTRY_ARCHIVE_AUTHORITY ?? "r2";
if (archiveAuthority !== "r2" && archiveAuthority !== "guix")
  throw new TypeError("REGISTRY_ARCHIVE_AUTHORITY must be r2 or guix");
const registrar = archiveAuthority === "guix"
  ? createGuixArchiveRegistrar({ guix: process.env.REGISTRY_GUIX_PROGRAM })
  : null;
const bucket = registrar === null ? metadataBucket : await createGuixArchiveBucket({
  metadataBucket, root: need("REGISTRY_GUIX_STATE"), collectorDirectory: need("REGISTRY_GUIX_ROOTS"),
  register: (source, root) => registrar.register(source, root),
});
// The native origin is reached directly, naming the canonical host as the reverse proxy does.
const nativeFetch = request => {
  const url = new URL(request.url);
  if (url.origin !== origin.origin) throw new TypeError("native requests stay on the canonical registry origin");
  const target = new URL(url.pathname + url.search, nativeOrigin), headers = new Headers(request.headers);
  headers.set("x-forwarded-host", origin.host); headers.set("x-forwarded-proto", "https");
  return fetch(new Request(target, { method: request.method, headers, body: request.body, duplex: "half",
    redirect: request.redirect, signal: request.signal }));
};
const registry = createR2Registry({ bucket, configuration, nativeFetch, publishToken: process.env.PUBLISH_TOKEN });

const server = createServer(async (incoming, outgoing) => {
  const abort = new AbortController();
  outgoing.once("close", () => { if (!outgoing.writableEnded) abort.abort(); });
  if (registrar !== null) outgoing.setHeader("X-Lagoon-Registry-Archive-Authority", "guix");
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (name !== "host" && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const request = new Request(new URL(incoming.url, origin), { method: incoming.method, headers, signal: abort.signal,
      ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: "half" }) });
    const reply = await registry.fetch(request);
    outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
    if (reply.body === null) outgoing.end();
    else await pipeline(Readable.fromWeb(reply.body), outgoing, { signal: abort.signal });
  } catch (error) {
    if (outgoing.headersSent || outgoing.destroyed) {
      outgoing.destroy();
      return;
    }
    outgoing.writeHead(502, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "registry publication writer failed: " + String(error?.message ?? error).slice(0, 300) }));
  }
});
server.once("close", () => { void registrar?.close(); });
server.listen(Number(need("PORT")), "127.0.0.1", () => console.log(JSON.stringify({
  stage: "start", port: Number(process.env.PORT), bucket: process.env.R2_BUCKET, archiveAuthority,
})));
