import { access, open, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const PACKAGE_NAME = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/u;

function inside(root, candidate) {
  const displacement = relative(root, candidate);
  return displacement === "" || (displacement !== ".." && !displacement.startsWith(`..${sep}`));
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function contentType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".tgz")) return "application/octet-stream";
  return "text/plain; charset=utf-8";
}

export function createPackageRegistryServer({ registryDirectory, openFile = open }) {
  // `resolve` is deliberately lexical: HOST/current remains in every target
  // pathname. Do not replace this with fs.realpath; activation atomically
  // retargets that symlink and a long-lived reader must observe the new face.
  const root = resolve(registryDirectory);
  return createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://registry.invalid");
      if (url.pathname === "/-/ping") {
        response.writeHead(200, { "content-type": "application/json" }).end(request.method === "HEAD" ? undefined : "{}\n");
        return;
      }
      if (url.pathname === "/-/whoami") {
        response.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer realm=private-npm-registry" }).end(request.method === "HEAD" ? undefined : '{"error":"unauthorized"}\n');
        return;
      }
      const target = await resolvePackageRegistryRequest({ registryDirectory: root, requestPath: url.pathname });
      if (!target) {
        response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}\n');
        return;
      }
      const type = contentType(target);
      if (type === "application/json" && PACKAGE_NAME.test(decodeURIComponent(url.pathname).replace(/^\/+/, ""))) {
        const metadata = rewriteMetadataTarballOrigins(JSON.parse(await readFile(target, "utf8")), new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).origin);
        const body = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
        response.writeHead(200, { "content-type": type, "content-length": body.byteLength, "cache-control": "no-cache" });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      // A pointer activation may happen between requests. Open once and derive
      // both the length and bytes from that descriptor, so one response cannot
      // advertise an old snapshot's size while streaming a new snapshot.
      const file = await openFile(target);
      try {
        const size = (await file.stat()).size;
        response.writeHead(200, { "content-type": type, "content-length": size, "cache-control": "public, immutable" });
        if (request.method === "HEAD" || size === 0) {
          await file.close();
          response.end();
        } else {
          file.createReadStream({ start: 0, end: size - 1 }).pipe(response);
        }
      } catch (error) {
        await file.close().catch(() => {});
        throw error;
      }
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(`${JSON.stringify({ error: error.message })}\n`);
    }
  });
}

export function rewriteMetadataTarballOrigins(metadata, origin) {
  const rewritten = structuredClone(metadata);
  for (const version of Object.values(rewritten.versions ?? {})) {
    if (typeof version?.dist?.tarball === "string") {
      const artifact = new URL(version.dist.tarball).pathname;
      version.dist.tarball = new URL(artifact, origin).href;
    }
  }
  return rewritten;
}

export async function resolvePackageRegistryRequest({ registryDirectory, requestPath }) {
  const root = resolve(registryDirectory);
  const decoded = decodeURIComponent(requestPath.replace(/^\/+/, ""));
  let relativeTarget = decoded;
  if (decoded.endsWith(".tgz") && !decoded.startsWith("tarballs/")) {
    const boundary = decoded.indexOf("/-/");
    const name = boundary < 0 ? null : decoded.slice(0, boundary);
    const filename = boundary < 0 ? null : decoded.slice(boundary + 3);
    if (name && filename && PACKAGE_NAME.test(name)) {
      const scoped = name.startsWith("@");
      const slash = name.indexOf("/");
      const leaf = scoped ? name.slice(slash + 1) : name;
      const expected = `${name}-${filename.slice(filename.lastIndexOf("-") + 1)}`;
      if (filename === expected) relativeTarget = `tarballs/${scoped ? `${name.slice(1, slash)}/` : ""}${leaf}/-/${leaf}-${filename.slice(filename.lastIndexOf("-") + 1)}`;
    }
  }
  // registry-receipt.json lives at the registry root, not under metadata/ —
  // it happens to satisfy PACKAGE_NAME's character class (hyphens and one
  // dot are legal in an unscoped name), so it must be excluded explicitly or
  // every reader of the receipt gets a 404 from the metadata/ branch below.
  const target = decoded !== "registry-receipt.json" && PACKAGE_NAME.test(decoded) && !decoded.includes(".tgz")
    ? join(root, "metadata", `${encodeURIComponent(decoded)}.json`)
    : resolve(root, relativeTarget);
  if (!inside(root, target) || !(await exists(target)) || !(await stat(target)).isFile()) return null;
  return target;
}

// --- serve-npm-registry-read: deploys the read-only HTTP face above -------
//
// Everything below composes createPackageRegistryServer (this module's own
// export, immediately above) into a runnable process: parse CLI options,
// listen, report one JSON listening notice, and close cleanly on SIGINT or
// SIGTERM. It is the same read operation this module already serves; running
// it is not a second, separable thing this package does.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4873;

function parsePort(value) {
  if (!/^\d+$/.test(value)) throw new Error("--port must be an integer from 0 through 65535");
  const port = Number(value);
  if (port > 65535) throw new Error("--port must be an integer from 0 through 65535");
  return port;
}

export function parseReadRegistryOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      registry: { type: "string" },
      host: { type: "string", default: DEFAULT_HOST },
      port: { type: "string", default: String(DEFAULT_PORT) },
    },
  });
  if (!values.registry) throw new Error("--registry is required and must name the built registry directory");
  return { registryDirectory: values.registry, host: values.host, port: parsePort(values.port) };
}

export function listeningNotice({ host, port }) {
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return JSON.stringify({ type: "NpmRegistryReadAppListening", endpoint: `http://${displayHost}:${port}` });
}

export function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function startReadOnlyRegistry(options, { createServer: createServerOverride = createPackageRegistryServer, write = process.stdout.write.bind(process.stdout) } = {}) {
  const server = createServerOverride({ registryDirectory: options.registryDirectory });
  await listen(server, options);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const notice = listeningNotice({ host: options.host, port });
  write(`${notice}\n`);
  return { server, notice, close: () => closeServer(server) };
}

export function installGracefulShutdown({ server, processRef = process, close = () => closeServer(server), onError = (error) => { processRef.stderr.write(`${error.stack ?? error.message}\n`); processRef.exitCode = 1; } }) {
  let closing;
  const shutdown = () => {
    if (!closing) {
      closing = Promise.resolve(close()).catch(onError).finally(() => {
        processRef.off("SIGINT", shutdown);
        processRef.off("SIGTERM", shutdown);
      });
    }
    return closing;
  };
  processRef.on("SIGINT", shutdown);
  processRef.on("SIGTERM", shutdown);
  return shutdown;
}

export async function serveNpmRegistryRead(argv, dependencies = {}) {
  const options = parseReadRegistryOptions(argv);
  const runtime = await startReadOnlyRegistry(options, dependencies);
  const shutdown = installGracefulShutdown({ server: runtime.server, processRef: dependencies.processRef, close: runtime.close, onError: dependencies.onShutdownError });
  return { ...runtime, options, shutdown };
}
