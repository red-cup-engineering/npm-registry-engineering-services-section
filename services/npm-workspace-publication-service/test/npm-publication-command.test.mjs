import assert from "node:assert/strict";
import test from "node:test";
import { npmPublicationArguments } from "../src/npm-publication-command.mjs";

test("stable and development publication commands carry explicit protected npm tags", () => {
  assert.deepEqual(
    npmPublicationArguments({ name: "@example/stable", version: "1.2.3" }, "https://registry.example/", undefined),
    ["publish", "--ignore-scripts", "--provenance=false", "--tag", "latest", "--loglevel=error", "--json", "--registry=https://registry.example/", "--@example:registry=https://registry.example/"],
  );
  assert.equal(npmPublicationArguments({ name: "@example/development", version: "1.3.0-dev.0" }, "https://registry.example/", "dev")[4], "dev");
  assert.throws(() => npmPublicationArguments({ name: "@example/development", version: "1.3.0-dev.0" }, "https://registry.example/", "latest"), /must publish with npm tag dev/u);
});
