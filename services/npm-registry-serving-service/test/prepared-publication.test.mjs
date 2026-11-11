import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { admittedPublication } from "../src/prepared-publication.mjs";
import { packTarball } from "./support/tarball.mjs";

const name = "@fixture/semantic-information";
const payload = '<urn:fixture:subject> <urn:fixture:predicate> "retained meaning" .\n';
function publication(repository) {
  const manifest = { name, version: "1.0.0", files: ["information.ttl"],
    ...(repository === undefined ? {} : { repository }),
    "@context": { meaning: "urn:fixture:meaning" }, meaning: { subject: "urn:fixture:subject" } };
  const bytes = packTarball({ "package.json": manifest, "information.ttl": payload });
  const file = "semantic-information-1.0.0.tgz";
  return { bytes, body: { name, versions: { "1.0.0": { ...manifest, dist: {
    tarball: `https://registry.invalid/${name}/-/${file}`,
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  } } }, "dist-tags": { latest: "1.0.0" }, _attachments: {
    [file]: { data: bytes.toString("base64"), length: bytes.length },
  } } };
}
for (const repository of [undefined, { type: "git", url: "https://gitlab.com/fixture/information.git" },
  { type: "git", url: "https://github.com/fixture/information.git", directory: "documents" }]) {
  test(`npm data codec preserves authored information and repository ${JSON.stringify(repository)}`, () => {
    const { body, bytes } = publication(repository), before = structuredClone(body);
    const admitted = admittedPublication(name, body, { versions: new Map() });
    assert.deepEqual(admitted.artifacts.get("semantic-information-1.0.0.tgz"), bytes);
    const manifest = admitted.manifests.get("1.0.0");
    assert.deepEqual(manifest.repository, repository);
    assert.deepEqual(manifest.meaning, body.versions["1.0.0"].meaning);
    assert.deepEqual(manifest["@context"], body.versions["1.0.0"]["@context"]);
    assert.equal(Object.hasOwn(manifest.dist, "tarball"), false);
    assert.deepEqual(body, before);
  });
}
for (const [reason, mutate] of [
  ["integrity", body => { body.versions["1.0.0"].dist.integrity = "sha512-wrong"; }],
  ["identity", body => { body.versions["1.0.0"].name = "another-package"; }],
  ["attachment", body => { body._attachments.unbound = body._attachments["semantic-information-1.0.0.tgz"]; }],
]) test(`npm data codec still refuses invalid ${reason}`, () => {
  const { body } = publication(); mutate(body);
  assert.throws(() => admittedPublication(name, body, { versions: new Map() }), TypeError);
});
