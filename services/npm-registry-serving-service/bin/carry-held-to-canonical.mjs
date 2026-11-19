#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { admittedConfiguration } from "../src/application.mjs";
import { carryHeld } from "../src/carry-held.mjs";
import { createPackageStore } from "../src/store.mjs";

// carry-held-to-canonical CONFIGURATION RECEIVER NAME...
// Carry the house versions this node's store holds and the canonical receiver (RECEIVER: scheme and host, e.g. the
// R2 publication path) does not, as that receiver's ordinary publications of their exact stored manifests and
// archives, with no dist-tag. Authenticates as NPM_REGISTRY_PUBLISHER with NPM_REGISTRY_PUBLISHER_PASSWORD, as the
// receiver's native authentication expects. One JSON line per package and a summary; exits 1 when any version was
// refused, diverged or unreadable.
const [path, receiver, ...names] = process.argv.slice(2);
if (!path || !/^https?:\/\/[^/]+$/u.test(receiver ?? "") || names.length === 0)
  throw new TypeError("usage: carry-held-to-canonical CONFIGURATION RECEIVER NAME...");
const { NPM_REGISTRY_PUBLISHER: user, NPM_REGISTRY_PUBLISHER_PASSWORD: password } = process.env;
if (!user || !password) throw new TypeError("NPM_REGISTRY_PUBLISHER and NPM_REGISTRY_PUBLISHER_PASSWORD name the publisher");
const configuration = admittedConfiguration(JSON.parse(await readFile(path, "utf8")));
const home = value => (isAbsolute(value) ? value : resolve(homedir(), value));
const store = createPackageStore({ storage: home(configuration.storage) });
const authorization = "Basic " + Buffer.from(user + ":" + password).toString("base64");
const summary = { packages: names.length, carried: 0, refused: 0, diverged: 0, unreadable: 0 };
for (const name of names) {
  const report = await carryHeld(store, name, { canonical: receiver, authorization });
  process.stdout.write(JSON.stringify(report) + "\n");
  for (const key of ["carried", "refused", "diverged", "unreadable"]) summary[key] += report[key].length;
}
process.stdout.write(JSON.stringify({ summary }) + "\n");
process.exitCode = summary.refused + summary.diverged + summary.unreadable > 0 ? 1 : 0;
