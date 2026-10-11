import assert from "node:assert/strict";
import { test } from "node:test";
import { declaredBins, hasPublicationSurface, lifecycleScripts, nodeEngineEvidence, softwareKind, summarizeSoftwareCensus } from "../src/software-estate.mjs";

test("Node engine evidence rejects a runtime below a declared minimum", () => {
  assert.equal(nodeEngineEvidence(">=24", "24.19.0").compatible, true);
  assert.equal(nodeEngineEvidence(">=24.0.0", "22.18.0").compatible, false);
  assert.equal(nodeEngineEvidence(undefined, "18.0.0").compatible, true);
});

test("lifecycle selection runs check, build, and test without duplicating verify", () => {
  assert.deepEqual(lifecycleScripts({ scripts: { check: "x", build: "x", test: "x", verify: "x" } }), ["build", "check", "test"]);
  assert.deepEqual(lifecycleScripts({ scripts: { verify: "x" } }), ["verify"]);
});

test("declared bins and software kinds distinguish executable, library, and aggregate packages", () => {
  assert.deepEqual(declaredBins({ name: "a", bin: "cli.mjs" }), [{ name: "a", path: "cli.mjs" }]);
  assert.equal(softwareKind({ bin: { a: "cli.mjs" } }), "executable");
  assert.equal(softwareKind({ exports: "." }), "library");
  assert.equal(softwareKind({ scripts: { test: "node --test" } }), "checked-aggregate");
  assert.equal(softwareKind({}), "aggregate");
});

test("registry artifacts require an explicit cross-machine surface", () => {
  assert.equal(hasPublicationSurface({ name: "section", version: "1.0.0" }), false);
  assert.equal(hasPublicationSurface({ files: ["Corpus/"] }), true);
  assert.equal(hasPublicationSurface({ exports: "./src/index.mjs" }), true);
  assert.equal(hasPublicationSurface({ bin: { run: "./scripts/run.mjs" } }), true);
});

test("census summary counts lifecycle and missing-bin evidence", () => {
  const summary = summarizeSoftwareCensus([
    { kind: "executable", lifecycle: ["test"], bins: [{ exists: true, status: "available" }, { exists: false, status: "missing-source" }, { exists: false, status: "pending-build" }], nodeEngine: { compatible: true } },
    { kind: "library", lifecycle: [], bins: [], nodeEngine: { compatible: false } },
  ]);
  assert.deepEqual(summary, {
    manifests: 2,
    executable: 1,
    library: 1,
    checkedAggregate: 0,
    aggregate: 0,
    lifecycleCommands: 1,
    declaredBins: 3,
    absentBins: 2,
    pendingBuildBins: 1,
    missingSourceBins: 1,
    incompatibleNodeEngines: 1,
  });
});
