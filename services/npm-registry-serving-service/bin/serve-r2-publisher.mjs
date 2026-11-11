#!/usr/bin/env node
// The canonical R2 registry's publication path, served in Node beside the native origin. The Cloudflare Worker
// runs the same createR2Registry code, but a publication there parses, re-serialises and reads back the whole
// package document inside the Worker's CPU bound, and large house packuments (1 to 2 MB) exceed it
// (exceededResources, answered as a 503 page). Here the same code writes the same R2 bucket through R2's S3 API,
// with the same conditional writes, so publishers that reach this server are not bounded by the Worker.
//
// Environment (every specific is a parameter):
//   PORT                                  listening port on 127.0.0.1
//   REGISTRY_CONFIGURATION, REGISTRY_IDENTITY_CONFLICTS, REGISTRY_IDENTITY_RESERVATIONS
//                                         the Worker's plain-text bindings, verbatim
//   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//                                         the bucket the Worker binds as R, and an S3 credential for it
//   NATIVE_ORIGIN_URL                     the native origin (identity, login, public uplink), e.g. http://127.0.0.1:18821
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { createR2Registry, workerConfiguration } from "../src/r2-registry.mjs";
import { createR2S3Bucket } from "../src/r2-s3-bucket.mjs";

const need = name => { const value = process.env[name]; if (!value) throw new TypeError(name + " is required"); return value; };
const configuration = workerConfiguration(process.env);
const origin = new URL(configuration.origin), nativeOrigin = new URL(need("NATIVE_ORIGIN_URL"));
const bucket = createR2S3Bucket({ accountId: need("R2_ACCOUNT_ID"), bucket: need("R2_BUCKET"),
  accessKeyId: need("R2_ACCESS_KEY_ID"), secretAccessKey: need("R2_SECRET_ACCESS_KEY") });
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

createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (name !== "host" && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    const request = new Request(new URL(incoming.url, origin), { method: incoming.method, headers,
      ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body }) });
    const reply = await registry.fetch(request);
    outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
    outgoing.end(Buffer.from(await reply.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(502, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "registry publication writer failed: " + String(error?.message ?? error).slice(0, 300) }));
  }
}).listen(Number(need("PORT")), "127.0.0.1", () => console.log(JSON.stringify({ stage: "start", port: Number(process.env.PORT), bucket: process.env.R2_BUCKET })));
