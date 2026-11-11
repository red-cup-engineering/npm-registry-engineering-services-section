import assert from "node:assert/strict";
import { test } from "node:test";
import { binTargets, exportTargets, resolveExport } from "../src/package-exports.mjs";

test("resolveExport follows Node: exact keys, conditions, sugar, patterns, null and legacy", () => {
  assert.deepEqual(resolveExport(undefined, "./anything"), { legacy: true });
  assert.deepEqual(resolveExport("./index.mjs", "."), { target: "./index.mjs" });
  assert.deepEqual(resolveExport("./index.mjs", "./x"), { target: null });
  assert.deepEqual(resolveExport({ import: "./i.mjs", default: "./d.cjs" }, "."), { target: "./i.mjs" });
  assert.deepEqual(resolveExport({ require: "./r.cjs", default: "./d.mjs" }, "."), { target: "./d.mjs" });
  assert.deepEqual(resolveExport({ require: "./r.cjs" }, "."), { target: null });
  assert.deepEqual(resolveExport({ ".": ["./a.mjs", "./b.mjs"] }, "."), { target: "./a.mjs" });
  const map = {
    "./package.json": "./package.json", "./features/*": "./src/features/*.mjs", "./features/private/*": null,
    "./features/special/*": { import: "./src/special/*/index.mjs" }, "./data/*.json": "./data/*.json",
  };
  assert.deepEqual(resolveExport(map, "./package.json"), { target: "./package.json" });
  assert.deepEqual(resolveExport(map, "./features/a/b"), { target: "./src/features/a/b.mjs" });
  assert.deepEqual(resolveExport(map, "./features/special/x"), { target: "./src/special/x/index.mjs" });
  assert.deepEqual(resolveExport(map, "./features/private/x"), { target: null }, "the longer pattern wins, and null excludes");
  assert.deepEqual(resolveExport(map, "./data/y.json"), { target: "./data/y.json" });
  assert.deepEqual(resolveExport(map, "./data/y.txt"), { target: null });
  assert.deepEqual(resolveExport(map, "./missing"), { target: null });
  assert.deepEqual(resolveExport({ ".": "./i.mjs", import: "./x.mjs" }, "."), { target: null }, "mixed keys are not an exports map");
});

test("exportTargets names every file Node can reach and ignores conditions it never resolves", () => {
  const targets = exportTargets({
    ".": { types: "./index.d.ts", import: "./index.mjs", require: "./index.cjs" },
    "./x": "./x.mjs", "./list": ["./a.mjs", "./b.mjs"], "./off": null,
    "./dev": { development: "./src.mjs", default: { import: "./nested.mjs" } },
  });
  assert.deepEqual(targets.map(({ where, target, alternatives }) => [where, target ?? alternatives]), [
    ['exports["."].import', "./index.mjs"], ['exports["."].require', "./index.cjs"], ['exports["./x"]', "./x.mjs"],
    ['exports["./list"]', ["./a.mjs", "./b.mjs"]], ['exports["./dev"].default.import', "./nested.mjs"],
  ]);
  assert.deepEqual(exportTargets("./only.mjs").map(({ target }) => target), ["./only.mjs"]);
  assert.deepEqual(exportTargets(undefined), []);
});

test("binTargets reads both forms of bin", () => {
  assert.deepEqual(binTargets({ bin: "./cli.mjs" }), [{ where: "bin", target: "./cli.mjs" }]);
  assert.deepEqual(binTargets({ bin: { a: "x.mjs", b: "y.mjs" } }).map(({ target }) => target), ["x.mjs", "y.mjs"]);
  assert.deepEqual(binTargets({}), []);
});
