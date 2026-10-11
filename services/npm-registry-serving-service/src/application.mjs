import { homedir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { createNpmRegistry } from "./registry.mjs";

const headerOf = (value) => (Array.isArray(value) ? value.join(",") : value);

/**
 * The registry as an application of a MetroPlat instance: requests whose Host is one of `hosts` are the
 * registry's, answered before the instance's sign-in and routes; every other request passes through.
 * Configuration: { hosts, origin, storage, htpasswd, privateScopes?, privateNames?, uplink? }; storage
 * and htpasswd are home-relative unless absolute.
 *
 * A host serves either a Fetch context (`request`, a Web Request) or the native one (`req`, Node's
 * IncomingMessage); both carry `url`. The native request becomes a Web Request only when it is the
 * registry's, its body streamed rather than read.
 */
export function npmRegistryApplication({ configuration = {} } = {}) {
  const hosts = new Set((configuration.hosts ?? []).map((host) => host.toLowerCase()));
  if (hosts.size === 0) throw new TypeError("the npm registry application names the hosts it answers");
  const home = (path) => resolve(homedir(), path);
  const registry = createNpmRegistry({
    storage: home(configuration.storage), htpasswd: home(configuration.htpasswd), origin: configuration.origin,
    privateScopes: configuration.privateScopes, privateNames: configuration.privateNames, uplink: configuration.uplink,
    cachePublicTarballs: configuration.cachePublicTarballs,
  });
  const hostOf = (context) => {
    const headers = context.request?.headers;
    const forwarded = headers ? headers.get("x-forwarded-host") ?? headers.get("host") : headerOf(context.req?.headers?.["x-forwarded-host"]) ?? context.req?.headers?.host;
    return (forwarded ?? context.url?.host ?? "").split(",")[0].trim().split(":")[0].toLowerCase();
  };
  const webRequestOf = (context) => {
    if (context.request instanceof Request) return context.request;
    const { req, url } = context;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, headerOf(value));
    const bodied = req.method !== "GET" && req.method !== "HEAD";
    return new Request(url.href, { method: req.method, headers, ...(bodied ? { body: Readable.toWeb(req), duplex: "half" } : {}) });
  };
  return Object.freeze({
    onRequest: (context) => {
      if (!hosts.has(hostOf(context))) return undefined;
      return registry.handle(webRequestOf(context)).catch((error) =>
        Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 }));
    },
  });
}
