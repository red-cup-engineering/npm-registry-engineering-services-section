import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeServer, installGracefulShutdown, parseReadRegistryOptions, startReadOnlyRegistry } from "../src/npm-registry-read-service.mjs";
import { isMainModule } from "../scripts/serve-npm-registry-read.mjs";
import { createServer, createServer as createLoopbackServer } from "node:http";

/** A loopback fixture server over the platform HTTP runtime; the code under test is its client. */
const createHttpServer = ({ handle }) => createLoopbackServer(handle);

test("requires an explicit registry directory and validates options", () => {
  assert.throws(() => parseReadRegistryOptions([]), /--registry is required/);
  assert.throws(() => parseReadRegistryOptions(["--registry"]), /argument missing/);
  assert.throws(() => parseReadRegistryOptions(["--registry", "registry", "--port", "nope"]), /--port must be an integer/);
  assert.deepEqual(parseReadRegistryOptions(["--registry", "/srv/registry"]), { registryDirectory: "/srv/registry", host: "127.0.0.1", port: 4873 });
  assert.deepEqual(parseReadRegistryOptions(["--registry", "/srv/registry", "--host", "127.0.0.1", "--port", "0"]), { registryDirectory: "/srv/registry", host: "127.0.0.1", port: 0 });
});

test("starts only an injected read server, reports its loopback endpoint, and closes it", async () => {
  let receivedRegistryDirectory;
  const output = [];
  const runtime = await startReadOnlyRegistry(
    { registryDirectory: "/srv/registry", host: "127.0.0.1", port: 0 },
    { createServer: ({ registryDirectory }) => {
      receivedRegistryDirectory = registryDirectory;
      return createHttpServer({ handle: (_request, response) => response.end("read-only") });
    }, write: (line) => output.push(line) },
  );
  try {
    assert.equal(receivedRegistryDirectory, "/srv/registry");
    assert.match(output.join(""), /^\{"type":"NpmRegistryReadAppListening","endpoint":"http:\/\/127\.0\.0\.1:\d+"\}\n$/);
  } finally {
    await runtime.close();
  }
});

test("SIGINT and SIGTERM share one graceful close operation", async () => {
  const processRef = new EventEmitter();
  processRef.stderr = { write() {} };
  let closes = 0;
  const shutdown = installGracefulShutdown({ server: {}, processRef, close: async () => { closes += 1; } });
  processRef.emit("SIGINT");
  processRef.emit("SIGTERM");
  await shutdown();
  assert.equal(closes, 1);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
});

test("closeServer resolves after a loopback server has stopped", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await closeServer(server);
  assert.equal(server.listening, false);
});

test("the executable bin is import-safe and recognizes npm-style symlink invocation", async () => {
  const packageRoot = new URL("..", import.meta.url);
  const script = new URL("../scripts/serve-npm-registry-read.mjs", import.meta.url);
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8"));
  const staging = await mkdtemp(join(tmpdir(), "npm-registry-read-bin-"));
  try {
    const linkedBin = join(staging, "serve-npm-registry-read");
    await symlink(script, linkedBin);
    assert.equal(await isMainModule({ argv: [process.execPath, linkedBin] }), true);
    assert.equal(manifest.bin["serve-npm-registry-read"], "./scripts/serve-npm-registry-read.mjs");
    assert.equal((await lstat(script)).mode & 0o111, 0o111);
    assert.equal(manifest.name, "@red-cup-engineering/npm-registry-read-service");
    assert.equal(new URL("../package.json", import.meta.url).pathname.startsWith(packageRoot.pathname), true);
  } finally { await rm(staging, { recursive: true, force: true }); }
});
