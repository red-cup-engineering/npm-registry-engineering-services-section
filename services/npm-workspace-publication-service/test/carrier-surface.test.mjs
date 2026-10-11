import assert from "node:assert/strict";
import { test } from "node:test";
import { carrierSurfaceViolations, packageExportSurfacePaths } from "../src/carrier-surface.mjs";

test("packageExportSurfacePaths lists every condition's concrete target, bin entries, and skips wildcards", () => {
  const manifest = {
    main: "./dist/index.mjs",
    exports: {
      ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
      "./cli": "./dist/cli.mjs",
      "./features/*": { import: "./dist/features/*.mjs" },
      "./package.json": "./package.json",
    },
    bin: { farolfi: "./dist/bin/farolfi.mjs" },
  };
  assert.deepEqual(packageExportSurfacePaths(manifest), [
    "dist/bin/farolfi.mjs",
    "dist/cli.mjs",
    "dist/index.d.mts",
    "dist/index.mjs",
    "package.json",
  ]);
});

test("packageExportSurfacePaths falls back to main when there is no root export", () => {
  assert.deepEqual(packageExportSurfacePaths({ main: "index.js" }), ["index.js"]);
});

test("packageExportSurfacePaths returns an empty surface for a non-object manifest", () => {
  assert.deepEqual(packageExportSurfacePaths(null), []);
  assert.deepEqual(packageExportSurfacePaths([]), []);
});

test("carrier surface admits post-build main, conditional exports, bins, and matched wildcard targets", () => {
  const manifest = {
    main: "./dist/index.mjs",
    exports: {
      ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
      "./features/*": { import: "./dist/features/*.mjs" },
      "./package.json": "./package.json",
    },
    bin: { example: "./scripts/example.mjs" },
  };
  assert.deepEqual(carrierSurfaceViolations(manifest, [
    "package/dist/index.mjs",
    "dist/index.d.mts",
    "dist/features/one.mjs",
    "scripts/example.mjs",
    "package.json",
  ]), []);
});

test("carrier surface reports every dead concrete promise and unmatched wildcard", () => {
  const violations = carrierSurfaceViolations({
    main: "index.js",
    exports: { "./index": "./src/index.mjs", "./features/*": "./dist/features/*.mjs" },
    bin: "./scripts/run.mjs",
  }, ["package.json", "src/index.mjs"]);
  assert.deepEqual(violations, [
    { kind: "missing-carrier-target", field: "main", target: "index.js" },
    { kind: "unmatched-carrier-pattern", field: "exports../features/*", target: "./dist/features/*.mjs" },
    { kind: "missing-carrier-target", field: "bin", target: "./scripts/run.mjs" },
  ]);
});

test("a valid root export supersedes an inert legacy main declaration", () => {
  assert.deepEqual(carrierSurfaceViolations({ main: "index.js", exports: { ".": "./src/index.mjs" } }, ["src/index.mjs"]), []);
});

test("carrier surface rejects external, traversing, empty, and malformed targets", () => {
  assert.deepEqual([
    ...carrierSurfaceViolations({ main: "../index.js" }, []),
    ...carrierSurfaceViolations({
    exports: { ".": "dependency", "./empty": "" },
    bin: { bad: "/bin/run" },
    }, []),
  ], [
    { kind: "invalid-carrier-target", field: "main", target: "../index.js" },
    { kind: "invalid-carrier-target", field: "exports..", target: "dependency" },
    { kind: "invalid-carrier-target", field: "exports../empty", target: "" },
    { kind: "invalid-carrier-target", field: "bin.bad", target: "/bin/run" },
  ]);
});

test("repeated wildcards use one Node package-export substitution", () => {
  assert.deepEqual(carrierSurfaceViolations({ exports: { "./pair/*": "./dist/*/copy-*.mjs" } }, ["dist/one/copy-two.mjs"]), [
    { kind: "unmatched-carrier-pattern", field: "exports../pair/*", target: "./dist/*/copy-*.mjs" },
  ]);
  assert.deepEqual(carrierSurfaceViolations({ exports: { "./pair/*": "./dist/*/copy-*.mjs" } }, ["dist/one/copy-one.mjs"]), []);
});
