import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFECT_KINDS, assayRegistryCustody } from "../src/assay-registry-custody.mjs";
import { quarantineRegistryCustodyDefects, readQuarantineLedger } from "../src/quarantine-registry-custody-defects.mjs";

function measure(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

async function writePackage(storageRoot, scope, name, { version, bytes, tarballFilename, attachmentFilename, dist }) {
  const dir = join(storageRoot, `@${scope}`, name);
  await mkdir(dir, { recursive: true });
  const packageName = `@${scope}/${name}`;
  // A missing artifact still has declared metadata in the packument; the
  // fixture simply withholds those bytes from storage.
  const measured = measure(bytes ?? Buffer.alloc(0));
  const declaredDist = {
    tarball: `http://127.0.0.1:4873/${packageName}/-/${tarballFilename}`,
    shasum: measured.shasum,
    integrity: measured.integrity,
    ...dist,
  };
  const packument = {
    name: packageName,
    versions: {
      [version]: { name: packageName, version, dist: declaredDist },
    },
    _attachments: {
      [attachmentFilename]: { shasum: measured.shasum, version },
    },
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(packument, null, 2));
  if (bytes !== null) await writeFile(join(dir, attachmentFilename), bytes);
  return { packageName, measured };
}

async function writeDb(storageRoot, list) {
  await writeFile(join(storageRoot, ".verdaccio-db.json"), JSON.stringify({ list, secret: "unused" }, null, 2));
}

async function snapshotTree(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push([path, await readFile(path)]);
    }
  }
  await walk(root);
  files.sort(([a], [b]) => a.localeCompare(b));
  return files;
}

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "npm-registry-custody-assay-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a fully intact owned package produces no defects", async () => {
  await withFixture(async (root) => {
    const healthy = Buffer.from("hello");
    await writePackage(root, "owned", "healthy-service", {
      version: "1.0.0",
      bytes: healthy,
      tarballFilename: "healthy-service-1.0.0.tgz",
      attachmentFilename: "healthy-service-1.0.0.tgz",
    });
    await writeDb(root, ["@owned/healthy-service"]);

    const result = await assayRegistryCustody({ storageRoot: root, ownedScopes: ["owned"] });
    assert.deepEqual(result.defects, []);
  });
});

test("reports dangling custody when the index claims a package storage never received", async () => {
  await withFixture(async (root) => {
    await writeDb(root, ["@owned/ghost-service"]);
    const result = await assayRegistryCustody({ storageRoot: root, ownedScopes: ["owned"] });
    assert.equal(result.defects.length, 1);
    assert.equal(result.defects[0].kind, DEFECT_KINDS.DANGLING_CUSTODY);
    assert.equal(result.defects[0].packageSurface, "@owned/ghost-service");
  });
});

test("reports an unresolvable artifact address when dist.tarball names a file outside the attachment catalog", async () => {
  await withFixture(async (root) => {
    const bytes = Buffer.from("hello");
    await writePackage(root, "owned", "misaddressed-service", {
      version: "1.0.0",
      bytes,
      tarballFilename: "different-service-1.0.0.tgz",
      attachmentFilename: "misaddressed-service-1.0.0.tgz",
    });
    await writeDb(root, ["@owned/misaddressed-service"]);

    const result = await assayRegistryCustody({ storageRoot: root, ownedScopes: ["owned"] });
    assert.equal(result.defects.length, 1);
    assert.equal(result.defects[0].kind, DEFECT_KINDS.UNRESOLVABLE_ARTIFACT_ADDRESS);
    assert.equal(result.defects[0].packageSurface, "@owned/misaddressed-service@1.0.0");
    assert.deepEqual(result.defects[0].detail.attachments, ["misaddressed-service-1.0.0.tgz"]);
  });
});

test("reports an unresolvable artifact address when the attachment catalog names a file storage does not hold", async () => {
  await withFixture(async (root) => {
    await writePackage(root, "owned", "missing-bytes-service", {
      version: "1.0.0",
      bytes: null,
      tarballFilename: "missing-bytes-service-1.0.0.tgz",
      attachmentFilename: "missing-bytes-service-1.0.0.tgz",
      dist: { shasum: "0000000000000000000000000000000000000000", integrity: "sha512-AA==" },
    });
    await writeDb(root, ["@owned/missing-bytes-service"]);

    const result = await assayRegistryCustody({ storageRoot: root, ownedScopes: ["owned"] });
    assert.equal(result.defects.length, 1);
    assert.equal(result.defects[0].kind, DEFECT_KINDS.UNRESOLVABLE_ARTIFACT_ADDRESS);
    assert.equal(result.defects[0].detail.filename, "missing-bytes-service-1.0.0.tgz");
  });
});

test("reports a corrupt artifact when stored bytes no longer hash to the package's own recorded digest", async () => {
  await withFixture(async (root) => {
    const declared = measure(Buffer.from("hello"));
    await writePackage(root, "owned", "bitrot-service", {
      version: "1.0.0",
      bytes: Buffer.from("goodbye"),
      tarballFilename: "bitrot-service-1.0.0.tgz",
      attachmentFilename: "bitrot-service-1.0.0.tgz",
      dist: declared,
    });
    await writeDb(root, ["@owned/bitrot-service"]);

    const result = await assayRegistryCustody({ storageRoot: root, ownedScopes: ["owned"] });
    assert.equal(result.defects.length, 1);
    assert.equal(result.defects[0].kind, DEFECT_KINDS.CORRUPT_ARTIFACT);
    assert.deepEqual(result.defects[0].detail.mismatches, ["shasum", "integrity"]);
    assert.deepEqual(result.defects[0].detail.recorded, declared);
  });
});

test("reports unlisted custody when storage holds a package the index does not know about", async () => {
  await withFixture(async (root) => {
    await writePackage(root, "owned", "unlisted-service", {
      version: "1.0.0",
      bytes: Buffer.from("hello"),
      tarballFilename: "unlisted-service-1.0.0.tgz",
      attachmentFilename: "unlisted-service-1.0.0.tgz",
    });
    await writeDb(root, []);

    const result = await assayRegistryCustody({ storageRoot: root, ownedScopes: ["owned"] });
    assert.equal(result.defects.length, 1);
    assert.equal(result.defects[0].kind, DEFECT_KINDS.UNLISTED_CUSTODY);
    assert.equal(result.defects[0].packageSurface, "@owned/unlisted-service");
  });
});

test("does not flag partial custody in scopes the caller does not own", async () => {
  await withFixture(async (root) => {
    // A proxied uplink scope: the index knows of many versions but this
    // registry only ever cached the tarball a client actually requested.
    const dir = join(root, "@thirdparty", "some-package");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "@thirdparty/some-package",
      versions: {
        "1.0.0": { name: "@thirdparty/some-package", version: "1.0.0", dist: { tarball: "https://upstream.example/some-package-1.0.0.tgz", shasum: "deadbeef" } },
        "2.0.0": { name: "@thirdparty/some-package", version: "2.0.0", dist: { tarball: "https://upstream.example/some-package-2.0.0.tgz", shasum: "deadbeef" } },
      },
      _attachments: {},
    }));
    await writeDb(root, ["@thirdparty/some-package", "@thirdparty/never-even-cached"]);

    const result = await assayRegistryCustody({ storageRoot: root, ownedScopes: ["owned"] });
    assert.deepEqual(result.defects, []);
  });
});

test("assay result is read-only: the fixture tree is byte-identical before and after", async () => {
  await withFixture(async (root) => {
    await writePackage(root, "owned", "healthy-service", {
      version: "1.0.0",
      bytes: Buffer.from("hello"),
      tarballFilename: "healthy-service-1.0.0.tgz",
      attachmentFilename: "healthy-service-1.0.0.tgz",
    });
    await writeDb(root, ["@owned/healthy-service", "@owned/ghost-service"]);

    const before = await snapshotTree(root);
    await assayRegistryCustody({ storageRoot: root, ownedScopes: ["owned"] });
    const after = await snapshotTree(root);
    assert.deepEqual(after, before);
  });
});

test("quarantine appends new defects once, is idempotent on repeat runs, and never mutates the registry", async () => {
  await withFixture(async (registryRoot) => {
    await writeDb(registryRoot, ["@owned/ghost-service"]);
    const ledgerRoot = await mkdtemp(join(tmpdir(), "npm-registry-custody-ledger-"));
    try {
      const ledgerPath = join(ledgerRoot, "nested", "registry-custody-quarantine.jsonl");
      const registryBefore = await snapshotTree(registryRoot);

      const first = await assayRegistryCustody({ storageRoot: registryRoot, ownedScopes: ["owned"] });
      const firstQuarantine = await quarantineRegistryCustodyDefects({ defects: first.defects, ledgerPath });
      assert.equal(firstQuarantine.appended.length, 1);
      assert.equal(firstQuarantine.alreadyQuarantined.length, 0);

      const second = await assayRegistryCustody({ storageRoot: registryRoot, ownedScopes: ["owned"] });
      const secondQuarantine = await quarantineRegistryCustodyDefects({ defects: second.defects, ledgerPath });
      assert.equal(secondQuarantine.appended.length, 0);
      assert.equal(secondQuarantine.alreadyQuarantined.length, 1);

      const ledger = await readQuarantineLedger(ledgerPath);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].kind, DEFECT_KINDS.DANGLING_CUSTODY);
      assert.equal(ledger[0].packageSurface, "@owned/ghost-service");
      assert.equal(typeof ledger[0].quarantinedAt, "string");

      const registryAfter = await snapshotTree(registryRoot);
      assert.deepEqual(registryAfter, registryBefore);

      const raw = await readFile(ledgerPath, "utf8");
      assert.equal(raw.split("\n").filter((line) => line.length > 0).length, 1);
    } finally {
      await rm(ledgerRoot, { recursive: true, force: true });
    }
  });
});

test("quarantine ledger append survives a missing ledger directory and never rewrites prior lines", async () => {
  await withFixture(async (registryRoot) => {
    await writeDb(registryRoot, ["@owned/first-ghost"]);
    const ledgerRoot = await mkdtemp(join(tmpdir(), "npm-registry-custody-ledger-"));
    try {
      const ledgerPath = join(ledgerRoot, "does", "not", "exist", "yet", "ledger.jsonl");
      assert.equal(await stat(join(ledgerRoot, "does")).catch((error) => error.code), "ENOENT");

      const firstDefects = (await assayRegistryCustody({ storageRoot: registryRoot, ownedScopes: ["owned"] })).defects;
      await quarantineRegistryCustodyDefects({ defects: firstDefects, ledgerPath });
      const afterFirst = await readFile(ledgerPath, "utf8");

      await writeDb(registryRoot, ["@owned/first-ghost", "@owned/second-ghost"]);
      const secondDefects = (await assayRegistryCustody({ storageRoot: registryRoot, ownedScopes: ["owned"] })).defects;
      await quarantineRegistryCustodyDefects({ defects: secondDefects, ledgerPath });
      const afterSecond = await readFile(ledgerPath, "utf8");

      assert.equal(afterSecond.startsWith(afterFirst), true);
      const ledger = await readQuarantineLedger(ledgerPath);
      assert.deepEqual(ledger.map((entry) => entry.packageSurface).sort(), ["@owned/first-ghost", "@owned/second-ghost"]);
    } finally {
      await rm(ledgerRoot, { recursive: true, force: true });
    }
  });
});
