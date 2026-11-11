import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectVerdaccioStorageReleases } from "@red-cup-engineering/verdaccio-storage-release-projection-service";

test("VERDACCIO-PROJECTION-QUICKSTART", async t => {
  const storageRoot = await mkdtemp(join(tmpdir(), "verdaccio-projection-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  await writeFile(join(storageRoot, ".verdaccio-db.json"), '{"list":[]}');
  const result = await projectVerdaccioStorageReleases({ storageRoot, ownedScopes: ["example"] });
  assert.equal(result.counts.indexedPackages, 0);
  assert.deepEqual(result.admitted, []);
  assert.deepEqual(result.excluded, []);
});
