#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { admittedConfiguration, identityConservationOf } from "../src/application.mjs";
import { peerFromSpecification, receivePeers } from "../src/peers.mjs";
import { registryIdentityConservation } from "../src/registry-identity-conservation.mjs";
import { createPackageStore } from "../src/store.mjs";

// receive-from-peers CONFIGURATION [--all-bytes] [--lockfile pnpm-lock.yaml]... [NAME]...
// Fill this node's store from the peers its configuration declares: for each house package named (or found in a
// pnpm lockfile), receive the versions the store does not hold, each checked against the integrity its packument
// advertised. Prints one JSON line per package and a summary; exits 1 when any version was missing, mismatched or diverged.
const [path, ...rest] = process.argv.slice(2);
if (!path) throw new TypeError("usage: receive-from-peers CONFIGURATION [--all-bytes] [--lockfile pnpm-lock.yaml]... [NAME]...");
const configuration = admittedConfiguration(JSON.parse(await readFile(path, "utf8")));
const home = value => (isAbsolute(value) ? value : resolve(homedir(), value));
const peers = (configuration.peers ?? []).map(specification => peerFromSpecification(specification));
if (peers.length === 0) throw new TypeError("the configuration declares no peers");
// The node's own identity conservation: a quarantined version is never received from a peer.
const conservation = registryIdentityConservation(identityConservationOf(configuration),
  { origin: configuration.origin, privateScopes: configuration.privateScopes ?? [], privateNames: configuration.privateNames ?? [] });
const isPrivate = name => (configuration.privateNames ?? []).includes(name) || (configuration.privateScopes ?? []).some(scope => name.startsWith(scope + "/"));
const names = new Set(), locked = new Set();
let allBytes = false;
for (let at = 0; at < rest.length; at++) {
  if (rest[at] === "--all-bytes") allBytes = true;
  else if (rest[at] === "--lockfile") {
    const text = await readFile(rest[++at], "utf8");
    for (const match of text.matchAll(/^ {2}'?((?:@[^/@'\s]+\/)?[^@'\s/]+)@([^\s:'(]+)[^\s:]*'?:\s*$/gmu)) if (isPrivate(match[1])) { names.add(match[1]); locked.add(match[1] + "@" + match[2]); }
  } else names.add(rest[at]);
}
const store = createPackageStore({ storage: home(configuration.storage) });
const summary = { packages: names.size, received: 0, versions: 0, absent: [], unchanged: 0, problems: [] };
for (const name of [...names].sort()) {
  const outcome = await receivePeers(store, name, peers, { origin: configuration.origin, eager: version => allBytes || locked.has(name + "@" + version),
    quarantined: version => conservation.conflict(name, version) !== undefined });
  process.stdout.write(JSON.stringify(outcome) + "\n");
  if (outcome.status === "received") { summary.received += 1; summary.versions += outcome.received.length; }
  else if (outcome.status === "absent") summary.absent.push(name); else summary.unchanged += 1;
  if (outcome.missing.length || outcome.mismatched.length || outcome.diverged.length || outcome.error) summary.problems.push(name);
}
process.stdout.write(JSON.stringify({ summary }) + "\n");
process.exitCode = summary.problems.length > 0 ? 1 : 0;
