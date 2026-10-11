import assert from "node:assert/strict";
import test from "node:test";
import { nonPackageOperationPublicationReason } from "../scripts/publish-package.mjs";

test("publication refuses Node operating-system operation names instead of versioning them", () => {
  for (const name of ["@red-cup-engineering/fern", "@red-cup-engineering/frog", "@red-cup-engineering/agent-organization-engine"]) {
    assert.match(nonPackageOperationPublicationReason(name), /not a publishable package/u);
  }
});

test("publication leaves actual package identities eligible for normal release checks", () => {
  assert.equal(nonPackageOperationPublicationReason("@red-cup-engineering/feltos"), null);
  assert.equal(nonPackageOperationPublicationReason("@red-cup-engineering/metroplat"), null);
});
