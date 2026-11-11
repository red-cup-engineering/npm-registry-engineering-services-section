import assert from "node:assert/strict";
import { test } from "node:test";
import { addUser, listUsers, removeUser, verifyUser } from "../src/htpasswd.mjs";

test("add, list, verify, remove round-trip", () => {
  const added = addUser("", "bare-cedar-fog", "hunter2");
  assert.equal(added.judgment, null);
  assert.deepEqual(listUsers(added.content), ["bare-cedar-fog"]);
  assert.equal(verifyUser(added.content, "bare-cedar-fog", "hunter2"), true);
  assert.equal(verifyUser(added.content, "bare-cedar-fog", "wrong"), false);
  const removed = removeUser(added.content, "bare-cedar-fog");
  assert.equal(removed.judgment, null);
  assert.deepEqual(listUsers(removed.content), []);
});

test("duplicate add and unknown remove refuse with judgments, leaving content unchanged", () => {
  const { content } = addUser("", "alpha", "pw");
  const dup = addUser(content, "alpha", "pw2");
  assert.equal(dup.judgment.name, "user-exists");
  assert.equal(dup.content, content);
  const missing = removeUser(content, "beta");
  assert.equal(missing.judgment.name, "user-unknown");
  assert.equal(missing.content, content);
});

test("malformed user names are refused", () => {
  const bad = addUser("", "Bad Name!", "pw");
  assert.equal(bad.judgment.name, "user-name");
});

test("preserves other entries and unknown hash schemes verbatim", () => {
  const seed = "legacy:$2y$somebcrypthash\n";
  const { content } = addUser(seed, "next", "pw");
  assert.deepEqual(listUsers(content), ["legacy", "next"]);
  const removed = removeUser(content, "next");
  assert.equal(removed.content, seed);
  assert.equal(verifyUser(content, "legacy", "anything"), false);
});
