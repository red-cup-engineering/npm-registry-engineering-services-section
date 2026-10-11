import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyExportSurfaceDiff } from "../src/export-surface-diff.mjs";

test("adding a file and an export name is additive", () => {
  const result = classifyExportSurfaceDiff({
    previousFiles: ["package.json", "src/index.mjs"],
    currentFiles: ["package.json", "src/index.mjs", "src/new.mjs"],
    exportDiffs: [{ subpath: ".", previousNames: ["a", "b"], currentNames: ["a", "b", "c"] }],
  });
  assert.deepEqual(result, { classification: "additive", removedFiles: [], orphanRemovedFiles: [], missingExports: [] });
});

test("removing a previously shipped file is breaking when reachableFiles is omitted (conservative default)", () => {
  const result = classifyExportSurfaceDiff({
    previousFiles: ["package.json", "src/gone.mjs"],
    currentFiles: ["package.json"],
    exportDiffs: [],
  });
  assert.equal(result.classification, "breaking");
  assert.deepEqual(result.removedFiles, ["src/gone.mjs"]);
  assert.deepEqual(result.orphanRemovedFiles, []);
});

test("removing a file outside the previous export surface is compatible, not breaking", () => {
  const result = classifyExportSurfaceDiff({
    previousFiles: ["package.json", "dist/index.mjs", "dist/orphan.mjs"],
    currentFiles: ["package.json", "dist/index.mjs"],
    exportDiffs: [],
    reachableFiles: ["dist/index.mjs", "package.json"],
  });
  assert.equal(result.classification, "additive");
  assert.deepEqual(result.removedFiles, []);
  assert.deepEqual(result.orphanRemovedFiles, ["dist/orphan.mjs"]);
});

test("removing a file inside the previous export surface stays breaking even with reachableFiles given", () => {
  const result = classifyExportSurfaceDiff({
    previousFiles: ["package.json", "dist/index.mjs", "dist/orphan.mjs"],
    currentFiles: ["package.json", "dist/orphan.mjs"],
    exportDiffs: [],
    reachableFiles: ["dist/index.mjs", "package.json"],
  });
  assert.equal(result.classification, "breaking");
  assert.deepEqual(result.removedFiles, ["dist/index.mjs"]);
  assert.deepEqual(result.orphanRemovedFiles, []);
});

test("dropping a previously exported name is breaking, even with the same files", () => {
  const result = classifyExportSurfaceDiff({
    previousFiles: ["src/index.mjs"],
    currentFiles: ["src/index.mjs"],
    exportDiffs: [{ subpath: ".", previousNames: ["a", "b"], currentNames: ["a"] }],
  });
  assert.equal(result.classification, "breaking");
  assert.deepEqual(result.missingExports, [{ subpath: ".", name: "b" }]);
});

test("a subpath removed entirely counts every one of its previous names as missing", () => {
  const result = classifyExportSurfaceDiff({
    previousFiles: ["src/index.mjs"],
    currentFiles: ["src/index.mjs"],
    exportDiffs: [{ subpath: "./extra", previousNames: ["x"], currentNames: null }],
  });
  assert.equal(result.classification, "breaking");
  assert.deepEqual(result.missingExports, [{ subpath: "./extra", name: "x" }]);
});

test("an unreadable previous side (null previousNames) is never treated as a removal", () => {
  const result = classifyExportSurfaceDiff({
    previousFiles: ["src/index.mjs"],
    currentFiles: ["src/index.mjs"],
    exportDiffs: [{ subpath: ".", previousNames: null, currentNames: ["a"] }],
  });
  assert.equal(result.classification, "additive");
});

test("a duplicate previous file entry does not double-count as removed", () => {
  const result = classifyExportSurfaceDiff({
    previousFiles: ["src/gone.mjs", "src/gone.mjs"],
    currentFiles: [],
    exportDiffs: [],
  });
  assert.deepEqual(result.removedFiles, ["src/gone.mjs"]);
});
