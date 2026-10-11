import assert from "node:assert/strict";
import { test } from "node:test";
import { concreteJavascriptExportTargets } from "../src/export-subpath-targets.mjs";

test("a string root export resolves to subpath \".\"", () => {
  assert.deepEqual(concreteJavascriptExportTargets({ exports: "./src/index.mjs" }), [{ subpath: ".", target: "./src/index.mjs" }]);
});

test("a conditions object for root export picks the import condition", () => {
  const manifest = { exports: { types: "./dist/index.d.mts", import: "./dist/index.mjs" } };
  assert.deepEqual(concreteJavascriptExportTargets(manifest), [{ subpath: ".", target: "./dist/index.mjs" }]);
});

test("a multi-subpath export map lists every concrete JavaScript target", () => {
  const manifest = {
    exports: {
      ".": "./src/index.mjs",
      "./semantic-version-audit": "./src/semantic-version-audit.mjs",
      "./package.json": "./package.json",
    },
  };
  assert.deepEqual(concreteJavascriptExportTargets(manifest), [
    { subpath: ".", target: "./src/index.mjs" },
    { subpath: "./semantic-version-audit", target: "./src/semantic-version-audit.mjs" },
  ]);
});

test("a wildcard subpath is excluded", () => {
  const manifest = { exports: { "./features/*": "./dist/features/*.mjs" } };
  assert.deepEqual(concreteJavascriptExportTargets(manifest), []);
});

test("falls back to main when exports is absent", () => {
  assert.deepEqual(concreteJavascriptExportTargets({ main: "./index.js" }), [{ subpath: ".", target: "./index.js" }]);
});

test("no exports and no main yields an empty list", () => {
  assert.deepEqual(concreteJavascriptExportTargets({}), []);
});
