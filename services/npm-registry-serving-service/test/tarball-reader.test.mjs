import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readTarball, TarballError } from "../src/tarball-reader.mjs";
import { packTarball, tarEntry } from "./support/tarball.mjs";

const archive = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

test("a tarball is read in memory as package-relative paths and bytes", () => {
  const files = readTarball(packTarball({ "package.json": '{"name":"x"}', "src/a.mjs": "export {};\n", "src/deep/b.mjs": "" }));
  assert.deepEqual([...files.keys()].sort(), ["package.json", "src/a.mjs", "src/deep/b.mjs"]);
  assert.equal(files.get("src/a.mjs").toString(), "export {};\n");
  assert.equal(files.get("src/deep/b.mjs").length, 0);
});

test("a path longer than a ustar name is carried by PAX and read back whole", () => {
  const long = `${"nested/".repeat(20)}file.mjs`;
  const files = readTarball(packTarball({ "package.json": "{}", [long]: "export const long = 1;\n" }));
  assert.equal(files.get(long).toString(), "export const long = 1;\n");
});

test("the top-level directory need not be called package", () => {
  assert.deepEqual([...readTarball(packTarball({ "package.json": "{}" }, { root: "anything" })).keys()], ["package.json"]);
});

test("a tarball that is not a safe npm tarball is refused", () => {
  const refused = (bytes, pattern) => assert.throws(() => readTarball(bytes), (error) => error instanceof TarballError && pattern.test(error.message));
  refused(Buffer.from("not gzip"), /not gzip/u);
  refused(archive(tarEntry("package/../escape.mjs", "x")), /unsafe/u);
  refused(archive(tarEntry("/absolute.mjs", "x")), /unsafe/u);
  refused(archive(tarEntry("package/link", "", "2")), /not a regular file/u);
  refused(archive(tarEntry("one/a", "x"), tarEntry("two/b", "x")), /one top-level directory/u);
  refused(archive(tarEntry("loose.mjs", "x")), /outside its top-level directory/u);
  const damaged = Buffer.concat([tarEntry("package/a", "x"), Buffer.alloc(1024)]);
  damaged[0] ^= 0xff;
  refused(gzipSync(damaged), /checksum/u);
  refused(gzipSync(Buffer.concat([tarEntry("package/a", "x".repeat(2000)).subarray(0, 700)])), /past the end/u);
});

test("an archive that inflates past its bound is refused rather than inflated", () => {
  const bomb = packTarball({ "package.json": "{}", "zeros.bin": Buffer.alloc(4 * 1024 * 1024) });
  assert.ok(bomb.length < 64 * 1024, "the bomb is small compressed");
  assert.throws(() => readTarball(bomb, { maxBytes: 1024 * 1024 }), /inflates past/u);
});
