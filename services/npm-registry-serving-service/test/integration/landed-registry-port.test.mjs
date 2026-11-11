import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const { createR2Registry } = await import(process.env.R2_REGISTRY_MODULE ? pathToFileURL(process.env.R2_REGISTRY_MODULE) : new URL("../../src/r2-registry.mjs", import.meta.url));
import { registryFixture, password } from "../support/registry.mjs";
import { MemoryR2 } from "../support/r2.mjs";
const modulePath = process.env.GITHUB_LANDING_PUBLICATION_MODULE;
const inputPath = process.env.PREPARED_NPM_PUBLICATION_INPUT;
if (!modulePath || !inputPath) throw Error("Select the original qualified publisher module and retained prepared input for integration receiving");
const moduleBefore = createHash("sha256").update(readFileSync(modulePath)).digest("hex");
const { houseRegistry } = await import(pathToFileURL(modulePath));
const encoded = readFileSync(inputPath), body = JSON.parse(encoded);
const inputSha256 = createHash("sha256").update(encoded).digest("hex");
const [version] = Object.keys(body.versions);
const manifest = body.versions[version], origin = new URL(manifest.dist.tarball).origin;

test("original houseRegistry port receives the exact retained publication and its public archive without fabricating source", async t => {
  const authority = await registryFixture(t, { origin });
  const bucket = new MemoryR2();
  const configuration = { origin, privateScopes: ["@red-cup-engineering", "@registry-fixture"], privateNames: [],
    nativePublisherPolicy: "native-authenticated-house-publishers-v1" };
  const receiver = createR2Registry({ bucket, configuration, nativeFetch: request => authority.request(new URL(request.url).pathname, {
    method: request.method, headers: request.headers,
  }) });
  let puts = 0;
  const registry = houseRegistry({ url: origin, origin, scopes: configuration.privateScopes, user: "fixture", password,
    fetchImpl: (url, options = {}) => {
      if (options.method === "PUT") {
        puts++;
        assert.equal(createHash("sha256").update(options.body).digest("hex"), inputSha256, "encoded original publication must not change");
      }
      return receiver.fetch(new Request(url, options));
    } });
  const result = await registry.publish(body.name, body);
  assert.equal(result.status, 201, result.text);
  assert.equal(puts, 1);
  const received = await registry.manifest(body.name, version);
  assert.deepEqual(received, manifest, "entire original version manifest, not only its identity, survives");
  const archive = await registry.tarball(received.dist.tarball);
  assert.equal("sha512-" + createHash("sha512").update(archive).digest("base64"), manifest.dist.integrity);
  assert.equal(received.gitHead, manifest.gitHead);
  assert.equal([...bucket.objects.keys()].some(key => key.startsWith("-/publication-inputs/")), false);
  assert.equal(createHash("sha256").update(readFileSync(inputPath)).digest("hex"), inputSha256, "caller input is preserved");
  assert.equal(createHash("sha256").update(readFileSync(modulePath)).digest("hex"), moduleBefore, "publisher source did not drift during this receiving");
});
