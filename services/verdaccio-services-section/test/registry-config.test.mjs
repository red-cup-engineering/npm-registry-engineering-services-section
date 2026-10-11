import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const localConfigPath = fileURLToPath(
  new URL("../content/config/config.yaml", import.meta.url),
);
const coldRedGateConfigPath = fileURLToPath(
  new URL("../content/config/cold-red-gate.yaml", import.meta.url),
);
const coldRedGateUnitPath = fileURLToPath(
  new URL("../content/deployment/systemd-user/cold-red-gate/verdaccio-561-group.service", import.meta.url),
);

test("the public fallback is read-only and proxies npmjs", () => {
  const config = readFileSync(localConfigPath, "utf8");
  const fallback = config.match(/^  '\*\*':\n((?: {4}.+\n)+)/m)?.[1] ?? "";

  assert.match(fallback, /^    access: \$all$/m);
  assert.match(fallback, /^    proxy: npmjs$/m);
  assert.doesNotMatch(fallback, /^    (?:un)?publish:/m);
});

test("the Cold Red Gate profile keeps house scopes private and proxies public packages", () => {
  const config = readFileSync(coldRedGateConfigPath, "utf8");
  const foundry = config.match(/^  '@foundry-rs\/\*':\n((?: {4}.+\n)+)/m)?.[1] ?? "";
  const fallback = config.match(/^  '\*\*':\n((?: {4}.+\n)+)/m)?.[1] ?? "";
  const scopes = [...config.matchAll(/^  '(@[^/']+)\/\*'/gm)].map((match) => match[1]);

  assert.match(config, /^uplinks:\n  npmjs:\n    url: https:\/\/registry\.npmjs\.org\/$/m);
  assert.match(foundry, /^    access: \$all$/m);
  assert.match(foundry, /^    proxy: npmjs$/m);
  assert.doesNotMatch(foundry, /^    (?:un)?publish:/m);
  assert.match(fallback, /^    access: \$all$/m);
  assert.match(fallback, /^    proxy: npmjs$/m);
  assert.doesNotMatch(fallback, /^    (?:un)?publish:/m);
  assert.deepEqual(scopes, [
    "@561-group",
    "@causeway-services",
    "@coesite-operations",
    "@emsenn",
    "@emsweb",
    "@foundry-rs",
    "@harmonious-union",
    "@koios-news",
    "@lenticule-science",
    "@red-cup-engineering",
    "@red-cup-science",
    "@rsc-quiescent",
    "@turntide-islands",
    "@union-officer-academy",
  ]);
});

test("the Cold Red Gate unit selects the host profile and hardens registry credentials", () => {
  const unit = readFileSync(coldRedGateUnitPath, "utf8");

  assert.match(unit, /^WorkingDirectory=\/home\/emsenn\/services\/verdaccio-561-group$/m);
  assert.match(unit, /configure-npm-scope-routing\.mjs --config content\/config\/cold-red-gate\.yaml/u);
  assert.match(unit, /harden-htpasswd-permissions\.mjs/u);
  assert.match(unit, /verdaccio.*--config content\/config\/cold-red-gate\.yaml/u);
});
