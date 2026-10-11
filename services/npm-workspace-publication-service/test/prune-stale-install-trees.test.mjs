import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "scripts", "prune-set-of-stale-install-trees.mjs");

const git = (cwd, args, env = {}) => run("git", ["-C", cwd, ...args], { env: { ...process.env, ...env } });

/**
 * Build a temp git repository with three package directories:
 * - pkg-fresh: has a lockfile and node_modules, committed just now (keep).
 * - pkg-old: has a lockfile and node_modules, committed far in the past (prune).
 * - pkg-old-no-lock: no lockfile, node_modules, committed far in the past (keep/refuse).
 * @returns {Promise<string>} The repository root.
 */
async function buildFixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "stale-install-trees-"));
  await run("git", ["init", "--quiet", root]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);

  const oldEnv = { GIT_AUTHOR_DATE: "2020-01-01T00:00:00", GIT_COMMITTER_DATE: "2020-01-01T00:00:00" };

  for (const name of ["pkg-old", "pkg-old-no-lock"]) {
    const dir = join(root, name);
    await mkdir(join(dir, "node_modules", "some-dep"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
    await writeFile(join(dir, "node_modules", "some-dep", "index.js"), "module.exports = {};\n".repeat(50));
    if (name === "pkg-old") await writeFile(join(dir, "package-lock.json"), JSON.stringify({ name, lockfileVersion: 3 }));
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "--quiet", "-m", "old packages"], oldEnv);

  const freshDir = join(root, "pkg-fresh");
  await mkdir(join(freshDir, "node_modules", "some-dep"), { recursive: true });
  await writeFile(join(freshDir, "package.json"), JSON.stringify({ name: "pkg-fresh" }));
  await writeFile(join(freshDir, "package-lock.json"), JSON.stringify({ name: "pkg-fresh", lockfileVersion: 3 }));
  await writeFile(join(freshDir, "node_modules", "some-dep", "index.js"), "module.exports = {};\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "--quiet", "-m", "fresh package"]);

  return root;
}

test("classifies a recently committed package as keep", async () => {
  const root = await buildFixtureRepo();
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, "--root", root]);
    const report = JSON.parse(stdout);
    assert.equal(report.kind, "npm.stale-install-trees");
    assert.equal(report.days, 30);
    const fresh = report.trees.find((tree) => tree.package === "pkg-fresh");
    assert.ok(fresh, "pkg-fresh must be reported");
    assert.equal(fresh.decision, "keep");
    assert.match(fresh.reason, /git commit within/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies an old package with a lockfile as prune", async () => {
  const root = await buildFixtureRepo();
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, "--root", root]);
    const report = JSON.parse(stdout);
    const old = report.trees.find((tree) => tree.package === "pkg-old");
    assert.ok(old, "pkg-old must be reported");
    assert.equal(old.decision, "prune");
    assert.ok(old.bytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to prune an old package with no lockfile, reporting why", async () => {
  const root = await buildFixtureRepo();
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, "--root", root]);
    const report = JSON.parse(stdout);
    const noLock = report.trees.find((tree) => tree.package === "pkg-old-no-lock");
    assert.ok(noLock, "pkg-old-no-lock must be reported");
    assert.equal(noLock.decision, "keep");
    assert.match(noLock.reason, /no lockfile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a systemd user unit referencing the package directory forces keep", async () => {
  const root = await buildFixtureRepo();
  const unitsDir = await mkdtemp(join(tmpdir(), "fake-units-"));
  try {
    await writeFile(
      join(unitsDir, "pkg-old.service"),
      `[Service]\nWorkingDirectory=${join(root, "pkg-old")}\nExecStart=/usr/bin/node index.mjs\n`,
    );
    const { stdout } = await run(process.execPath, [SCRIPT, "--root", root, "--units-dir", unitsDir]);
    const report = JSON.parse(stdout);
    const old = report.trees.find((tree) => tree.package === "pkg-old");
    assert.equal(old.decision, "keep");
    assert.match(old.reason, /systemd user unit pkg-old\.service/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(unitsDir, { recursive: true, force: true });
  }
});

test("totals and sort order: prune candidates first, descending by bytes", async () => {
  const root = await buildFixtureRepo();
  try {
    const { stdout } = await run(process.execPath, [SCRIPT, "--root", root]);
    const report = JSON.parse(stdout);
    assert.equal(report.totals.keep, 2);
    assert.equal(report.totals.prune, 1);
    assert.equal(report.totals.pruneBytes, report.trees.find((tree) => tree.decision === "prune").bytes);
    assert.equal(report.trees[0].decision, "prune");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--apply removes only the prune tree's node_modules, keeping the others", async () => {
  const root = await buildFixtureRepo();
  try {
    await run(process.execPath, [SCRIPT, "--root", root, "--apply"]);

    await assert.rejects(stat(join(root, "pkg-old", "node_modules")));

    const freshStat = await stat(join(root, "pkg-fresh", "node_modules"));
    assert.ok(freshStat.isDirectory());
    const noLockStat = await stat(join(root, "pkg-old-no-lock", "node_modules"));
    assert.ok(noLockStat.isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--apply reports removed count and bytes", async () => {
  const root = await buildFixtureRepo();
  try {
    const { stdout: planStdout } = await run(process.execPath, [SCRIPT, "--root", root]);
    const plan = JSON.parse(planStdout);
    const expectedBytes = plan.trees.find((tree) => tree.package === "pkg-old").bytes;

    const { stdout } = await run(process.execPath, [SCRIPT, "--root", root, "--apply"]);
    const outcome = JSON.parse(stdout);
    assert.equal(outcome.removed, 1);
    assert.equal(outcome.bytes, expectedBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--root is required", async () => {
  await assert.rejects(run(process.execPath, [SCRIPT]), (error) => {
    assert.match(error.stderr, /--root <dir> is required/);
    return true;
  });
});

test("--format only accepts json", async () => {
  const root = await buildFixtureRepo();
  try {
    await assert.rejects(run(process.execPath, [SCRIPT, "--root", root, "--format", "yaml"]), (error) => {
      assert.match(error.stderr, /--format must be json/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
