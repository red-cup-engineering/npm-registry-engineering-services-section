import assert from "node:assert/strict";
import test from "node:test";
import {
  forwardGuixArchiveRequest,
  guixArchiveRequest,
  GUIX_ARCHIVE_AUTHORITY_HEADER as authority,
  withoutGuixArchiveAuthority,
} from "../src/worker-guix-archive-route.mjs";

const configuration = {
  origin: "https://registry.example",
  privateScopes: ["@house"],
  privateNames: ["internal-tool"],
};
const request = (path, options) => new Request(configuration.origin + path, options);

test("Guix routing selects house tarballs and archive-affecting changes only", () => {
  for (const [method, path] of [
    ["GET", "/@house%2fpkg/-/pkg-1.0.0.tgz"],
    ["HEAD", "/internal-tool/-/internal-tool-1.0.0.tgz"],
    ["PUT", "/@house/pkg"],
    ["PUT", "/@house/pkg/-rev/revision"],
    ["DELETE", "/@house/pkg/-rev/revision"],
    ["DELETE", "/@house/pkg/-/pkg-1.0.0.tgz/-rev/revision"],
    ["PUT", "/-/package/@house/pkg/dist-tags/latest"],
    ["POST", "/-/publication-inputs/@house/pkg/1.0.0/resume"],
  ]) assert.equal(guixArchiveRequest(request(path, { method }), configuration), true, method + " " + path);
  for (const [method, path] of [
    ["GET", "/@house/pkg"],
    ["GET", "/@house/pkg/1.0.0"],
    ["GET", "/-/package/@house/pkg/dist-tags"],
    ["GET", "/semver/-/semver-7.7.3.tgz"],
    ["PUT", "/-/user/org.couchdb.user:publisher"],
    ["GET", "/-/whoami"],
    ["GET", "/-/ping"],
    ["POST", "/-/npm/v1/security/advisories/bulk"],
    ["POST", "/-/publication-inputs/@outside/pkg/1.0.0/resume"],
    ["GET", "/@house%ZZpkg/-/pkg-1.0.0.tgz"],
  ]) assert.equal(guixArchiveRequest(request(path, { method }), configuration), false, method + " " + path);
  assert.equal(guixArchiveRequest(new Request("https://other.example/@house/pkg/-/pkg-1.0.0.tgz"), configuration), false);
});

test("caller cannot select the native archive route", () => {
  const withMarker = request("/-/whoami", { headers: { [authority]: "guix", authorization: "Bearer fixture" } });
  const clean = withoutGuixArchiveAuthority(withMarker);
  assert.equal(clean.headers.has(authority), false);
  assert.equal(clean.headers.get("authorization"), "Bearer fixture");
  assert.equal(guixArchiveRequest(clean, configuration), false);
});

test("native origin receives the original authenticated publication bytes exactly once", async () => {
  const original = request("/@house%2fpkg", {
    method: "PUT", body: "publication bytes",
    headers: { authorization: "Bearer fixture", "content-type": "application/json" },
  });
  let seen = 0;
  const result = await forwardGuixArchiveRequest(original, async forwarded => {
    ++seen;
    assert.equal(forwarded.url, original.url);
    assert.equal(forwarded.method, "PUT");
    assert.equal(forwarded.redirect, "manual");
    assert.equal(forwarded.headers.get("authorization"), "Bearer fixture");
    assert.equal(forwarded.headers.get(authority), "guix");
    assert.equal(await forwarded.text(), "publication bytes");
    return new Response("received", { status: 201, headers: { [authority]: "guix" } });
  });
  assert.equal(seen, 1);
  assert.equal(result.status, 201);
  assert.equal(await result.text(), "received");
});

test("Guix route preserves conditional replies and refuses an unqualified origin", async () => {
  for (const [response, expected] of [
    [new Response(null, { status: 304, headers: { [authority]: "guix" } }), 304],
    [new Response("legacy"), 502],
    [new Response(null, { status: 302, headers: { [authority]: "guix", location: "/different" } }), 502],
  ]) {
    const reply = await forwardGuixArchiveRequest(
      request("/@house/pkg/-/pkg-1.0.0.tgz", { headers: { "if-none-match": '"abc"' } }),
      async forwarded => {
        assert.equal(forwarded.headers.get("if-none-match"), '"abc"');
        return response;
      },
    );
    assert.equal(reply.status, expected);
  }
  let attempts = 0;
  const lostReply = await forwardGuixArchiveRequest(request("/@house/pkg", { method: "PUT" }), async () => {
    ++attempts;
    throw new Error("no response");
  });
  assert.equal(attempts, 1);
  assert.equal(lostReply.status, 502);
});
