import assert from "node:assert/strict";
import test from "node:test";

import { packageBinaries, readPackageInterfaces } from "../src/package-interfaces.mjs";

test("normalizes npm string, object, and legacy array bin declarations", () => {
  assert.deepEqual(packageBinaries({ name: "@customer/tool", bin: "./scripts/tool.mjs" }), [
    { name: "tool", target: "scripts/tool.mjs" },
  ]);
  assert.deepEqual(packageBinaries({ name: "@customer/tool", bin: { "nested/run": ".\\scripts\\run.mjs", inspect: "C:\\scripts\\inspect.mjs" } }), [
    { name: "inspect", target: "C/scripts/inspect.mjs" },
    { name: "run", target: "scripts/run.mjs" },
  ]);
  assert.deepEqual(packageBinaries({ name: "@customer/tool", bin: ["./scripts/start.mjs", "./scripts/stop.mjs"] }), [
    { name: "start.mjs", target: "scripts/start.mjs" },
    { name: "stop.mjs", target: "scripts/stop.mjs" },
  ]);
});

test("drops malformed bins the way an npm interface readout should", () => {
  assert.deepEqual(packageBinaries({ name: "@customer/tool", bin: { valid: "./valid.mjs", empty: "", nope: false } }), [
    { name: "valid", target: "valid.mjs" },
  ]);
  assert.deepEqual(packageBinaries({ bin: "./unnamed.mjs" }), []);
});

test("reads and freezes standard package interfaces without interpreting them", () => {
  const interfaces = readPackageInterfaces({
    name: "@customer/tool",
    exports: { ".": { node: "./node.mjs", default: "./portable.mjs" }, "./schema": "./schema.json" },
    imports: { "#internal": "./src/internal.mjs" },
    main: "./legacy.cjs",
    module: "./module.mjs",
    typings: "./types/index.d.ts",
    bin: { tool: "./scripts/tool.mjs" },
    scripts: { test: "node --test", invalid: false, check: "node --check index.mjs" },
    engines: { npm: ">=11", node: ">=22", invalid: 22 },
    os: ["linux", "darwin", "linux"],
    cpu: "x64",
  });

  assert.deepEqual(interfaces, {
    entrypoints: {
      exports: { ".": { node: "./node.mjs", default: "./portable.mjs" }, "./schema": "./schema.json" },
      imports: { "#internal": "./src/internal.mjs" },
      main: "./legacy.cjs",
      module: "./module.mjs",
      types: "./types/index.d.ts",
    },
    binaries: [{ name: "tool", target: "scripts/tool.mjs" }],
    scripts: [{ name: "check", command: "node --check index.mjs" }, { name: "test", command: "node --test" }],
    constraints: {
      engines: [{ name: "node", range: ">=22" }, { name: "npm", range: ">=11" }],
      os: ["darwin", "linux"],
      cpu: ["x64"],
    },
  });
  assert.ok(Object.isFrozen(interfaces));
  assert.ok(Object.isFrozen(interfaces.entrypoints.exports["."]));
  assert.ok(Object.isFrozen(interfaces.binaries));
  assert.ok(Object.isFrozen(interfaces.scripts));
  assert.ok(Object.isFrozen(interfaces.constraints.engines));
});

test("refuses a non-object manifest", () => {
  assert.throws(() => readPackageInterfaces(null), TypeError);
  assert.throws(() => readPackageInterfaces([]), TypeError);
});
