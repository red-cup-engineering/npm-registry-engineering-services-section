import assert from "node:assert/strict";
import { test } from "node:test";
import { planSoftwareVerification, executeSoftwareVerification } from "../src/software-verification.mjs";
const pkg = (name, dependencies = {}, lifecycle = ["build", "test"]) => ({ name, version: "0.1.0", dir: name, path: name + "/package.json", dependencies, lifecycle });

test("exact dependency closure excludes different installed versions", () => {
  const all = [pkg("app", { provider: "0.1.0", old: "0.0.9" }), pkg("provider"), pkg("old")];
  assert.deepEqual(planSoftwareVerification(all, { packages: ["app"], includeDependencies: true }).tiers, [["provider"], ["app"]]);
  assert.throws(() => planSoftwareVerification(all, { packages: ["absent"] }), /absent/);
  assert.throws(() => planSoftwareVerification([pkg("a"), pkg("a")]), /duplicate/);
});
test("lifecycle stages never race; prerequisites complete before consumers", async () => {
  const plan = planSoftwareVerification([pkg("a"), pkg("b"), pkg("c", { a: "0.1.0" })]);
  const active = new Set(), done = new Set();
  let max = 0;
  const result = await executeSoftwareVerification(plan, { concurrency: 2, run: async (job) => {
    assert.equal(active.has(job.package), false);
    if (job.package === "c") assert.ok(done.has("a:test"));
    if (job.script === "test") assert.ok(done.has(job.package + ":build"));
    active.add(job.package);
    max = Math.max(max, active.size);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active.delete(job.package);
    done.add(job.package + ":" + job.script);
    return { status: "passed" };
  } });
  assert.equal(max, 2);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 6);
});
test("failed build blocks its tests and dependents, independent work continues", async () => {
  const result = await executeSoftwareVerification(planSoftwareVerification([pkg("bad"), pkg("dependent", { bad: "0.1.0" }), pkg("good")]), {
    run: async ({ package: name }) => ({ status: name === "bad" ? "failed" : "passed" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.packageStates.good, "passed");
  assert.equal(result.results.filter((row) => row.status === "blocked").length, 3);
});
test("cycles and their dependents cannot run", async () => {
  const plan = planSoftwareVerification([pkg("a", { b: "0.1.0" }), pkg("b", { a: "0.1.0" }), pkg("c", { a: "0.1.0" })]);
  const result = await executeSoftwareVerification(plan, { run: async () => { assert.fail("cyclic job ran"); } });
  assert.equal(result.ok, false);
  assert.deepEqual(plan.cyclic, ["a", "b", "c"]);
});

