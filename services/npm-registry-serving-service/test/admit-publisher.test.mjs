import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNpmRegistry } from "../src/registry.mjs";
import { createCredentials } from "../src/credentials.mjs";
import { publishBody } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { run } from "./support/registry.mjs";

const bin = fileURLToPath(new URL("../bin/admit-publisher.mjs", import.meta.url));

test("a node admits a publisher by password and registers an existing sign-in token without keeping either", async t => {
  const root = await mkdtemp(join(tmpdir(), "admit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = join(root, "registry.json"), npmrc = join(root, "npmrc"), token = "hnr_" + "A".repeat(43);
  await writeFile(configuration, JSON.stringify({ hosts: ["registry.invalid"], origin: "http://registry.invalid", storage: join(root, "storage"), htpasswd: join(root, "htpasswd") }));
  await writeFile(npmrc, `//registry.invalid/:_authToken=${token}\n`);
  const first = await run(process.execPath, [bin, configuration, "service", "--password-environment", "SERVICE_PASSWORD"], { env: { ...process.env, SERVICE_PASSWORD: "s3cret-for-test" } });
  const second = await run(process.execPath, [bin, configuration, "person", "--token-from-npmrc", npmrc, "registry.invalid"]);
  for (const out of [first.stdout, second.stdout]) assert.ok(!out.includes("s3cret-for-test") && !out.includes(token));
  const credentials = createCredentials({ htpasswd: join(root, "htpasswd"), tokens: join(root, "tokens.jsonl") });
  assert.equal(await credentials.verify("service", "s3cret-for-test"), "service");
  assert.equal(await credentials.verify("person", "anything"), null, "a tokenless-password account cannot sign in by password");
  assert.equal(await credentials.bearer(token), "person");
  const registry = createNpmRegistry({ storage: join(root, "storage"), htpasswd: join(root, "htpasswd"), origin: "http://registry.invalid", privateScopes: ["@registry-fixture"] });
  const bytes = packagedVersion("@registry-fixture/admitted", "1.0.0"), body = publishBody(bytes, { origin: "http://registry.invalid" });
  const reply = await registry.handle(new Request("http://registry.invalid/" + encodeURIComponent(body.name), { method: "PUT", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal(reply.status, 201, await reply.clone().text());
});
