import assert from "node:assert/strict";
import { test } from "node:test";
import { javascriptModuleExportedNames } from "../src/javascript-export-names.mjs";

test("lists named function and class declarations", () => {
  const result = javascriptModuleExportedNames("export function foo() {}\nexport class Bar {}\n");
  assert.deepEqual([...result.names].sort(), ["Bar", "foo"]);
  assert.equal(result.hasStarExport, false);
});

test("lists exported const/let bindings, including multiple declarators", () => {
  const result = javascriptModuleExportedNames("export const a = 1, b = 2;\nexport let c = 3;\n");
  assert.deepEqual([...result.names].sort(), ["a", "b", "c"]);
});

test("lists an export-list statement, including a rename", () => {
  const result = javascriptModuleExportedNames("const x = 1;\nfunction y() {}\nexport { x, y as z };\n");
  assert.deepEqual([...result.names].sort(), ["x", "z"]);
});

test("counts a default export as \"default\"", () => {
  const result = javascriptModuleExportedNames("export default function named() {}\n");
  assert.deepEqual(result.names, ["default"]);
});

test("flags an export-star re-export instead of guessing its names", () => {
  const result = javascriptModuleExportedNames("export * from \"./other.mjs\";\nexport const known = 1;\n");
  assert.equal(result.hasStarExport, true);
  assert.deepEqual(result.names, ["known"]);
});

test("a declaration exported once and re-exported under another name lists both bindings once each", () => {
  const result = javascriptModuleExportedNames("export function f() {}\nexport { f as g };\n");
  assert.deepEqual([...result.names].sort(), ["f", "g"]);
});

test("throws a SyntaxError on unparseable source", () => {
  assert.throws(() => javascriptModuleExportedNames("export const = ;"), SyntaxError);
});

test("throws a TypeError on non-string input", () => {
  assert.throws(() => javascriptModuleExportedNames(null), TypeError);
});
