import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPackageStore } from "../src/store.mjs";

const name = "@example/package";

async function temporaryStore(t) {
  const storage = await mkdtemp(join(tmpdir(), "npm-store-lock-test-"));
  t.after(() => rm(storage, { recursive: true, force: true }));
  return storage;
}

test("a failed legacy write cannot leave a package permanently locked", async (t) => {
  const storage = await temporaryStore(t);
  const directory = join(storage, name);
  const lock = join(directory, ".lock");
  await mkdir(directory, { recursive: true });
  await writeFile(lock, "");
  const old = new Date(Date.now() - 5 * 60_000);
  await utimes(lock, old, old);

  const store = createPackageStore({ storage, lockWaitMs: 250 });
  await store.lock(name, async () => {
    const owner = await readFile(lock, "utf8");
    assert.match(owner, new RegExp(`^${process.pid} \\S+\\n$`, "u"));
  });
  await assert.rejects(readFile(lock), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(storage, "-", "locks")), []);
});

test("a fresh incomplete owner record keeps the legacy writer's grace period", async (t) => {
  const storage = await temporaryStore(t);
  const directory = join(storage, name);
  const lock = join(directory, ".lock");
  await mkdir(directory, { recursive: true });
  await writeFile(lock, "");

  const store = createPackageStore({ storage, lockWaitMs: 20 });
  await assert.rejects(store.lock(name, () => assert.fail("a competing writer entered")), {
    code: "PACKAGE_LOCKED",
  });
  assert.equal(await readFile(lock, "utf8"), "");
  assert.deepEqual(await readdir(join(storage, "-", "locks")), []);
});

test("independent store instances serialize writes and release the lock after failure", async (t) => {
  const storage = await temporaryStore(t);
  const first = createPackageStore({ storage });
  const second = createPackageStore({ storage, lockWaitMs: 20 });

  await first.lock(name, async () => {
    await assert.rejects(second.lock(name, () => assert.fail("a competing writer entered")), {
      code: "PACKAGE_LOCKED",
    });
  });
  await assert.rejects(first.lock(name, () => { throw new Error("failed write"); }), /failed write/u);
  assert.equal(await second.lock(name, () => "recovered"), "recovered");
  assert.deepEqual(await readdir(join(storage, "-", "locks")), []);
});
