import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {promisify} from "node:util";
import {createGuixArchiveRegistrar} from "../src/guix-archive-registration.mjs";

const run = promisify(execFile);
const nativeGuix = process.env.NPM_REGISTRY_TEST_NATIVE_GUIX === "1" ? process.env.NPM_REGISTRY_TEST_GUIX : undefined;

test("one registrar process handles concurrent admissions and individual refusals", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "registry-guix-protocol-"));
  const program = join(temporary, "guix");
  await writeFile(program, `#!${process.execPath}
const assert = require("node:assert/strict");
const {createInterface} = require("node:readline");
assert.deepEqual(process.argv.slice(2, 5), ["repl", "-q", "--"]);
let previous = 0;
const input = createInterface({input: process.stdin});
input.on("line", line => {
  const {id, file} = JSON.parse(line);
  assert.equal(id, ++previous);
  const archive = "/gnu/store/" + "0".repeat(32) + "-npm-registry-archive.tgz";
  const reply = file.endsWith("/refused") ? {error:"foreign collector root"} : {archive};
  console.log(JSON.stringify({id, ...reply}));
});
`);
  await chmod(program, 0o700);
  const registrar = createGuixArchiveRegistrar({guix: program});
  try {
    const received = await Promise.allSettled([
      registrar.register("/staging/one.tgz", "/roots/one"),
      registrar.register("/staging/refused", "/roots/two"),
      registrar.register("/staging/three.tgz", "/roots/three"),
    ]);
    assert.equal(received[0].status, "fulfilled");
    assert.equal(received[2].status, "fulfilled");
    assert.equal(received[0].value, received[2].value);
    assert.equal(received[1].status, "rejected");
    assert.match(received[1].reason.message, /foreign collector root/u);
    await registrar.close();
    await assert.rejects(registrar.register("/staging/four.tgz", "/roots/four"), /closed/u);
  } finally {
    await registrar.close();
    await rm(temporary, {recursive: true, force: true});
  }
});

test("Guix refuses an unreadable permanent collector after closing its temporary root", {skip: !nativeGuix}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "registry-guix-private-"));
  await chmod(temporary, 0o700);
  const registrar = createGuixArchiveRegistrar({guix: nativeGuix});
  try {
    const source = join(temporary, "archive.tgz");
    const root = join(temporary, "archive-root");
    await writeFile(source, `private collector liveness fixture ${temporary}\n`);
    await assert.rejects(
      registrar.register(source, root),
      /collector is not visible to Guix garbage collection/u,
    );
    await chmod(temporary, 0o755);
    const archive = await registrar.register(source, root);
    assert.equal(await readlink(root), archive);
    assert.deepEqual(await readFile(archive), await readFile(source));
  } finally {
    await registrar.close();
    await rm(temporary, {recursive: true, force: true});
  }
});

test("Guix interns exact npm archive bytes and honors independent collector roots", {skip: !nativeGuix}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "registry-guix-admission-"));
  await chmod(temporary, 0o755);
  const registrar = createGuixArchiveRegistrar({guix: nativeGuix});
  let artifact;
  const sha512 = async file => createHash("sha512").update(await readFile(file)).digest("hex");
  try {
    const artifactA = join(temporary, "a.tgz");
    const artifactB = join(temporary, "b.tgz");
    await mkdir(join(temporary, "package"));
    await writeFile(join(temporary, "package/package.json"), JSON.stringify({
      name: "@example/guix", version: "1.0.0", testInstance: temporary,
    }));
    await run("tar", ["-czf", artifactA, "-C", temporary, "package"]);
    await writeFile(artifactB, await readFile(artifactA));
    const rootA = join(temporary, "root-a");
    const rootB = join(temporary, "root-b");
    const [storedA, storedB] = await Promise.all([
      registrar.register(artifactA, rootA),
      registrar.register(artifactB, rootB),
    ]);
    artifact = storedA;
    assert.equal(storedB, storedA);
    assert.equal(await readlink(rootA), artifact);
    assert.equal(await readlink(rootB), artifact);
    assert.equal(await sha512(artifactA), await sha512(artifact));
    assert.equal(await registrar.register(artifactA, rootA), artifact);

    const mismatchedRoot = join(temporary, "mismatched");
    await symlink(artifactA, mismatchedRoot);
    await assert.rejects(registrar.register(artifactB, mismatchedRoot), /diverged/u);
    assert.equal(await readlink(mismatchedRoot), artifactA);
    await assert.rejects(run(nativeGuix, ["gc", "--delete", artifact]));
  } finally {
    await registrar.close();
    await rm(temporary, {recursive: true, force: true});
    if (artifact) await run(nativeGuix, ["gc", "--delete", artifact]);
  }
});
