import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDistStaleness } from "../src/dist-staleness.mjs";

test("fresh: every built file is newer than the newest source file", () => {
  const result = classifyDistStaleness({
    sourceFiles: [{ path: "src/a.mjs", mtimeMs: 100 }, { path: "src/b.mjs", mtimeMs: 200 }],
    builtFiles: [{ path: "dist/a.mjs", mtimeMs: 300 }, { path: "dist/b.mjs", mtimeMs: 250 }],
  });
  assert.equal(result.stale, false);
  assert.equal(result.newestSource.path, "src/b.mjs");
  assert.equal(result.oldestBuilt.path, "dist/b.mjs");
});

test("stale: the oldest built file predates the newest source file", () => {
  const result = classifyDistStaleness({
    sourceFiles: [{ path: "src/a.mjs", mtimeMs: 100 }, { path: "src/b.mjs", mtimeMs: 500 }],
    builtFiles: [{ path: "dist/a.mjs", mtimeMs: 300 }, { path: "dist/b.mjs", mtimeMs: 400 }],
  });
  assert.equal(result.stale, true);
  assert.equal(result.newestSource.path, "src/b.mjs");
  assert.equal(result.oldestBuilt.path, "dist/a.mjs");
});

test("no-dist: an empty built-file listing is never stale", () => {
  const result = classifyDistStaleness({ sourceFiles: [{ path: "src/a.mjs", mtimeMs: 100 }], builtFiles: [] });
  assert.equal(result.stale, false);
  assert.equal(result.oldestBuilt, null);
  assert.equal(result.newestSource.path, "src/a.mjs");
});

test("no source files is never stale either (nothing to compare against)", () => {
  const result = classifyDistStaleness({ sourceFiles: [], builtFiles: [{ path: "dist/a.mjs", mtimeMs: 100 }] });
  assert.equal(result.stale, false);
  assert.equal(result.newestSource, null);
  assert.equal(result.oldestBuilt.path, "dist/a.mjs");
});
