import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRegistryLiveness } from "../src/registry-liveness.mjs";

const OK_FETCH = async () => ({ status: 200 });
function scriptedExec(script) {
  let call = 0;
  return async (command, args) => {
    const step = script[call++];
    if (!step) throw new Error(`unexpected extra command: ${command} ${args.join(" ")}`);
    if (step.throws) throw step.throws;
    return step.result ?? { stdout: "", stderr: "" };
  };
}

test("passes every check in order and reports evidence for each", async () => {
  const execFileImpl = scriptedExec([
    { result: { stdout: "PONG 123ms\n", stderr: "" } },
    { result: { stdout: "morgan\n", stderr: "" } },
    { result: { stdout: "https://registry.561.group/\n", stderr: "" } },
  ]);
  const result = await checkRegistryLiveness({ registry: "https://registry.561.group", scope: "@red-cup-engineering", fetchImpl: OK_FETCH, execFileImpl });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.httpStatus, 200);
  assert.equal(result.evidence.npmWhoami, "morgan");
});

test("refuses on a non-200 GET without running any npm command", async () => {
  let execCalled = false;
  const execFileImpl = async () => { execCalled = true; return { stdout: "", stderr: "" }; };
  const result = await checkRegistryLiveness({ registry: "https://registry.561.group", fetchImpl: async () => ({ status: 503 }), execFileImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /returned 503/);
  assert.equal(execCalled, false);
});

test("refuses when the GET transport throws", async () => {
  const result = await checkRegistryLiveness({
    registry: "http://127.0.0.1:1",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    execFileImpl: async () => ({ stdout: "", stderr: "" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);
});

test("refuses when npm ping fails", async () => {
  const execFileImpl = scriptedExec([{ throws: Object.assign(new Error("boom"), { stderr: "npm ERR! network" }) }]);
  const result = await checkRegistryLiveness({ registry: "https://registry.561.group", fetchImpl: OK_FETCH, execFileImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /npm ping/);
});

test("refuses when npm whoami fails (stale credentials)", async () => {
  const execFileImpl = scriptedExec([
    { result: { stdout: "PONG\n", stderr: "" } },
    { throws: Object.assign(new Error("boom"), { stderr: "npm ERR! code E401" }) },
  ]);
  const result = await checkRegistryLiveness({ registry: "https://registry.561.group", fetchImpl: OK_FETCH, execFileImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /whoami/);
});

test("refuses when the scope routes to a different registry", async () => {
  const execFileImpl = scriptedExec([
    { result: { stdout: "PONG\n", stderr: "" } },
    { result: { stdout: "morgan\n", stderr: "" } },
    { result: { stdout: "http://127.0.0.1:4873/\n", stderr: "" } },
  ]);
  const result = await checkRegistryLiveness({ registry: "https://registry.561.group", scope: "@red-cup-engineering", fetchImpl: OK_FETCH, execFileImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /routes to/);
});

test("requires execFileImpl", async () => {
  await assert.rejects(checkRegistryLiveness({ registry: "https://registry.561.group" }), TypeError);
});
