import assert from "node:assert/strict";
import test from "node:test";
import { addUser, listUsers } from "@red-cup-engineering/npm-registry-user-service";

test("REGISTRY-USERS-QUICKSTART", () => {
  const result = addUser("", "fixture-user", "example-passphrase");
  assert.equal(result.judgment, null);
  assert.deepEqual(listUsers(result.content), ["fixture-user"]);
});
