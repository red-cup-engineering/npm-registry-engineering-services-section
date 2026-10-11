import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";

import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer as createLoopbackServer } from "node:http";

/** A loopback fixture server over the platform HTTP runtime; the code under test is its client. */
const createHttpServer = ({ handle }) => createLoopbackServer(handle);

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "publish-package.mjs");
const REAL_NPM = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();

/** Fakes only `ping`/`whoami` (no real registry needed); every other npm subcommand runs for real. */
async function runGateAgainstFixture(fixtureName, gateArgs = []) {
  const server = createHttpServer({ handle: (request, response) => {
    if (request.url === "/") { response.writeHead(200); response.end("{}"); return; }
    response.writeHead(404); response.end("not found");
  } });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const registry = `http://127.0.0.1:${server.address().port}/`;

  const root = mkdtempSync(join(tmpdir(), "publish-package-build-step-"));
  const bin = join(root, "bin");
  const packageDir = join(root, "package");
  try {
    cpSync(join(HERE, "fixtures", fixtureName), packageDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const npmShim = join(bin, "npm");
    writeFileSync(npmShim, `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "ping") { process.stdout.write("PONG\\n"); process.exit(0); }
if (args[0] === "whoami") { process.stdout.write("build-step-test-user\\n"); process.exit(0); }
try {
  process.stdout.write(execFileSync(${JSON.stringify(REAL_NPM)}, args, { cwd: process.cwd() }));
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exit(error.status ?? 1);
}
`);
    chmodSync(npmShim, 0o755);

    // This file itself runs under `node --test`, which sets NODE_TEST_CONTEXT
    // in the environment; left in place, the fixture's own `npm test` (a
    // nested `node --test`) detects the ambient context and skips itself.
    const gateEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete gateEnv.NODE_TEST_CONTEXT;
    delete gateEnv.NODE_TEST_WORKER_ID;
    const outcome = await run(process.execPath, [SCRIPT, "--package", packageDir, "--registry", registry, ...gateArgs], {
      maxBuffer: 16 * 1024 * 1024,
      env: gateEnv,
    }).catch((error) => error);
    return { outcome, packageDir, root };
  } finally {
    await new Promise((accept) => server.close(accept));
  }
}

test("the build step runs a declared build script and the published tarball carries its fresh output", async () => {
  const { outcome, packageDir, root } = await runGateAgainstFixture("publish-package-build-success-fixture");
  try {
    const report = JSON.parse(outcome.stdout);
    assert.equal(report.outcome, "planned", JSON.stringify(report, null, 2));
    const buildStep = report.steps.find((step) => step.name === "build");
    assert.ok(buildStep, "expected a build step in the report");
    assert.equal(buildStep.ok, true);
    assert.equal(buildStep.evidence.ran, true);
    assert.equal(buildStep.evidence.staleness.stale, false);

    const packed = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageDir, maxBuffer: 8 * 1024 * 1024 });
    const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
    assert.ok(files.includes("dist/x.mjs"), `expected dist/x.mjs among packed files: ${files.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a build script that exits 1 refuses build-failed and never reaches a later step", async () => {
  const { outcome, root } = await runGateAgainstFixture("publish-package-build-failure-fixture");
  try {
    assert.equal(outcome.code, 2, outcome.stderr);
    const report = JSON.parse(outcome.stdout);
    assert.equal(report.outcome, "refused");
    assert.equal(report.refusal.step, 2);
    assert.match(report.refusal.reason, /^build-failed:/);
    assert.deepEqual(report.steps.map((step) => step.name), ["registry-liveness", "fresh-install", "build"]);
    assert.equal(report.refusal.evidence.ran, true);
    assert.match(report.refusal.evidence.stderrTail, /intentional build failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
