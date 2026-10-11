import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHousePublicationVersion, classifyReleaseVersion, nextPatchVersion, nextPrereleaseVersion, planReleaseWave, publicationTagForVersion } from "../src/release-wave.mjs";

const pkg = (name, version, dependencies = {}, extra = {}) => ({
  name,
  version,
  private: false,
  manifest: { name, version, dependencies, ...extra },
});
test("next patch skips identities already occupied in an immutable registry", () => {
  assert.equal(nextPatchVersion("1.2.3", new Set(["1.2.4", "1.2.5"])), "1.2.6");
});

test("a breaking 0.x bump advances the minor coordinate and publication refuses 1.x", () => {
  assert.equal(planReleaseWave([pkg("leaf", "0.8.4")], ["leaf"], new Map([["leaf", new Set(["0.8.4"])]]), { bump: "major" }).targets[0].to, "0.9.0");
  assert.throws(() => assertHousePublicationVersion("@red-cup-engineering/leaf", "1.0.0"), /remain below 1\.0\.0/u);
  assert.doesNotThrow(() => assertHousePublicationVersion("semver", "7.7.2"));
});

test("development versions use one tag and a numeric sequence beginning at zero", () => {
  assert.deepEqual(classifyReleaseVersion("1.4.0-dev.0"), {
    version: "1.4.0-dev.0", kind: "prerelease", base: "1.4.0", major: 1, minor: 4, patch: 0, channel: "dev", sequence: 0,
  });
  assert.equal(nextPrereleaseVersion("1.3.9", "dev", new Set()), "1.3.10-dev.0");
  assert.equal(nextPrereleaseVersion("1.3.9", "dev", new Set(["1.3.9"])), "1.3.10-dev.0");
  assert.equal(nextPrereleaseVersion("1.4.0-dev.0", "dev", new Set(["1.4.0-dev.0", "1.4.0-dev.1"])), "1.4.0-dev.2");
  assert.equal(nextPrereleaseVersion("1.4.0-dev.2", "rc", new Set()), "1.4.0-rc.0");
});

test("npm dist tags cannot move latest across the stable-development boundary", () => {
  assert.equal(publicationTagForVersion("0.2.3", undefined), "latest");
  assert.equal(publicationTagForVersion("0.2.3", "latest"), "latest");
  assert.equal(publicationTagForVersion("0.2.4-dev.0", "dev"), "dev");
  assert.throws(() => publicationTagForVersion("0.2.4-dev.0"), /requires explicit --tag dev/u);
  assert.throws(() => publicationTagForVersion("0.2.4-dev.0", "latest"), /must publish with npm tag dev/u);
  assert.throws(() => publicationTagForVersion("0.2.3", "dev"), /must publish with npm tag latest/u);
});

test("release planning propagates exact targets to a fixed point", () => {
  const packages = [
    pkg("leaf", "1.0.0"),
    pkg("middle", "2.0.0", { leaf: "1.0.0" }),
    pkg("root", "3.0.0", { middle: "2.0.0" }),
  ];
  const occupied = new Map(packages.map(({ name, version }) => [name, new Set([version])]));
  const plan = planReleaseWave(packages, ["leaf"], occupied);
  assert.deepEqual(plan.targets, [
    { name: "leaf", from: "1.0.0", to: "1.0.1", bumped: true },
    { name: "middle", from: "2.0.0", to: "2.0.1", bumped: true },
    { name: "root", from: "3.0.0", to: "3.0.1", bumped: true },
  ]);
  assert.deepEqual(plan.dependencyEdits, [
    { consumer: "middle", field: "dependencies", dependency: "leaf", from: "1.0.0", to: "1.0.1" },
    { consumer: "root", field: "dependencies", dependency: "middle", from: "2.0.0", to: "2.0.1" },
  ]);
});

test("unoccupied releases keep their version and private consumers do not publish", () => {
  const packages = [
    pkg("leaf", "1.0.0"),
    { ...pkg("private-app", "1.0.0", { leaf: "0.9.0" }), private: true },
  ];
  const plan = planReleaseWave(packages, ["leaf"], new Map());
  assert.deepEqual(plan.targets, [{ name: "leaf", from: "1.0.0", to: "1.0.0", bumped: false }]);
  assert.deepEqual(plan.dependencyEdits, [
    { consumer: "private-app", field: "dependencies", dependency: "leaf", from: "0.9.0", to: "1.0.0" },
  ]);
});

test("a prerelease wave allocates tag zero and propagates exact prerelease dependencies", () => {
  const packages = [pkg("leaf", "1.0.0"), pkg("root", "2.0.0", { leaf: "1.0.0" })];
  const occupied = new Map(packages.map(({ name, version }) => [name, new Set([version])]));
  const plan = planReleaseWave(packages, ["leaf"], occupied, { releaseKind: "prerelease", channel: "dev", bump: "minor" });
  assert.deepEqual(plan.targets, [
    { name: "leaf", from: "1.0.0", to: "1.1.0-dev.0", bumped: true },
    { name: "root", from: "2.0.0", to: "2.1.0-dev.0", bumped: true },
  ]);
  assert.equal(plan.dependencyEdits[0].to, "1.1.0-dev.0");
});

test("an explicitly selected prerelease wave defaults its channel to dev", () => {
  const plan = planReleaseWave([pkg("leaf", "1.0.0")], ["leaf"], new Map([["leaf", new Set(["1.0.0"])]]), { releaseKind: "prerelease" });
  assert.equal(plan.channel, "dev");
  assert.equal(plan.targets[0].to, "1.0.1-dev.0");
});

test("a stable wave promotes a development carrier only to its unoccupied base", () => {
  const admission = new Map([["leaf", { prerelease: "1.4.0-rc.2", outcome: "carrier-verified", receipt: "ni:///sha-256;verified" }]]);
  const occupied = new Map([["leaf", new Set(["1.4.0-rc.2"])]]);
  assert.equal(planReleaseWave([pkg("leaf", "1.4.0-rc.2")], ["leaf"], occupied, { releaseKind: "stable", promotionAdmissions: admission }).targets[0].to, "1.4.0");
  assert.throws(
    () => planReleaseWave([pkg("leaf", "1.4.0-rc.2")], ["leaf"], new Map([["leaf", new Set(["1.4.0-rc.2", "1.4.0"])]]), { releaseKind: "stable", promotionAdmissions: admission }),
    /stable target 1\.4\.0 is already occupied/u,
  );
  assert.throws(() => planReleaseWave([pkg("leaf", "1.4.0-rc.2")], ["leaf"], occupied, { releaseKind: "stable" }), /carrier-verified promotion admission/u);
  assert.throws(() => planReleaseWave([pkg("leaf", "1.4.0-rc.2")], ["leaf"], new Map(), { releaseKind: "stable", promotionAdmissions: admission }), /absent from the authoritative registry/u);
});
