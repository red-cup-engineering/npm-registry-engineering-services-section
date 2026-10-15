import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { bumpPackageVersion, preflightRepinConsumers } from "../scripts/publish-package.mjs";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "publish-package.mjs");
const FIXTURE = join(HERE, "fixtures", "publish-package-gate-fixture");

test("plan mode against a dead registry port refuses at step 0 with a refusal datum, exit 2", async () => {
  await assert.rejects(
    run(process.execPath, [SCRIPT, "--package", FIXTURE, "--registry", "http://127.0.0.1:1"], { maxBuffer: 8 * 1024 * 1024 }),
    (error) => {
      assert.equal(error.code, 2);
      const report = JSON.parse(error.stdout);
      assert.equal(report.outcome, "refused");
      assert.equal(report.refusal.step, 0);
      assert.equal(typeof report.refusal.reason, "string");
      assert.ok(report.refusal.reason.length > 0);
      assert.deepEqual(report.steps.map((step) => step.step), [0]);
      assert.equal(report.steps[0].ok, false);
      return true;
    },
  );
});

test("an applying run outside any services section refuses before it touches the registry", async () => {
  const requests = [];
  const registry = createServer((request, response) => { requests.push(request.url); response.writeHead(503).end(); });
  await new Promise((done) => registry.listen(0, "127.0.0.1", done));
  const outside = mkdtempSync(join(tmpdir(), "publish-package-outside-"));
  try {
    writeFileSync(join(outside, "package.json"), readFileSync(join(FIXTURE, "package.json")));
    await assert.rejects(
      run(process.execPath, [SCRIPT, "--package", outside, "--apply", "--registry", `http://127.0.0.1:${registry.address().port}`], { maxBuffer: 8 * 1024 * 1024 }),
      (error) => {
        assert.match(error.stderr, /no ancestor \*-services-section carrying data\/ was found/);
        return true;
      },
    );
    assert.deepEqual(requests, []);
  } finally {
    registry.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("--package is required", async () => {
  await assert.rejects(run(process.execPath, [SCRIPT], { maxBuffer: 8 * 1024 * 1024 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /--package <dir> is required/);
    return true;
  });
});

test("--help prints deterministic usage without requiring a package", async () => {
  const result = await run(process.execPath, [SCRIPT, "--help"], { maxBuffer: 8 * 1024 * 1024 });
  assert.match(result.stdout, /^usage: publish-package --package <dir>/u);
});

test("repin preflight reports every invalid consumer before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "publish-package-repin-preflight-"));
  try {
    const valid = join(root, "valid");
    const duplicate = join(root, "duplicate");
    mkdirSync(valid); mkdirSync(duplicate);
    writeFileSync(join(valid, "package.json"), JSON.stringify({ name: "@example/valid", dependencies: { "@example/provider": "1.0.0" } }));
    writeFileSync(join(duplicate, "package.json"), JSON.stringify({ name: "@example/duplicate", dependencies: { "@example/provider": "1.0.0" }, devDependencies: { "@example/provider": "1.0.0" } }));
    const result = await preflightRepinConsumers({ repin: [valid, join(root, "missing"), duplicate], packageName: "@example/provider" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.consumers.map(({ ok, reason }) => ({ ok, reason })), [
      { ok: true, reason: undefined },
      { ok: false, reason: "consumer directory does not exist or is not a directory" },
      { ok: false, reason: "consumer declares @example/provider in more than one dependency field" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repin preflight refuses before the registry liveness effect", async () => {
  await assert.rejects(
    run(process.execPath, [SCRIPT, "--package", FIXTURE, "--repin", "/definitely/not/a/consumer", "--registry", "http://127.0.0.1:1"], { maxBuffer: 8 * 1024 * 1024 }),
    (error) => {
      assert.equal(error.code, 2);
      const report = JSON.parse(error.stdout);
      assert.equal(report.outcome, "refused");
      assert.equal(report.refusal.step, -2);
      assert.deepEqual(report.steps.map((step) => step.name), ["consumer-preflight"]);
      return true;
    },
  );
});

test("npm version synchronizes package-lock identity without scripts or a git tag", async () => {
  const packageDir = mkdtempSync(join(tmpdir(), "publish-package-version-"));
  const marker = join(packageDir, "lifecycle-ran");
  try {
    writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "version-fixture", version: "1.0.0", scripts: { preversion: `node -e \"require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\"` } }, null, 2)}\n`);
    writeFileSync(join(packageDir, "package-lock.json"), `${JSON.stringify({ name: "version-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "version-fixture", version: "1.0.0" } } }, null, 2)}\n`);
    await bumpPackageVersion({ packageDir, toVersion: "1.0.1" });
    assert.equal(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version, "1.0.1");
    assert.equal(JSON.parse(readFileSync(join(packageDir, "package-lock.json"), "utf8")).packages[""].version, "1.0.1");
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(packageDir, ".git")), false);
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("--bump rejects an unrecognized value", async () => {
  await assert.rejects(run(process.execPath, [SCRIPT, "--package", FIXTURE, "--bump", "epic"], { maxBuffer: 8 * 1024 * 1024 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /--bump must be patch, minor, or major/);
    return true;
  });
});
