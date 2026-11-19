#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import bcrypt from "bcryptjs";
import { validatedConfiguration } from "../src/application.mjs";
import { TOKEN_PREFIX } from "../src/credentials.mjs";

// admit-publisher CONFIGURATION USER [--origin URL] [--password-environment NAME] [--token-from-npmrc PATH REGISTRY-HOST]
// A node's accounts are its operator's. This admits USER to this node's htpasswd: with the password held in the named
// environment variable (stored only as a bcrypt hash), or with no usable password (`!`), signing in by token alone;
// and registers an existing registry sign-in token (the `_authToken` an .npmrc holds for REGISTRY-HOST) so it signs
// in USER here. Only a digest of a token is kept. Nothing secret is printed.
const [path, user, ...flags] = process.argv.slice(2);
if (!path || !user || !/^[A-Za-z0-9._-]{1,64}$/u.test(user)) throw new TypeError("usage: admit-publisher CONFIGURATION USER [--password-environment NAME] [--token-from-npmrc PATH REGISTRY-HOST]");
const document = JSON.parse(await readFile(path, "utf8"));
let origin;
for (let at = 0; at < flags.length; at++) {
  if (flags[at] === "--origin") {
    if (origin !== undefined) throw new TypeError("publisher admission selects one registry origin");
    const selected = new URL(flags[++at]);
    if (selected.username || selected.password || selected.search || selected.hash || selected.pathname !== "/"
      || !["http:", "https:"].includes(selected.protocol)) throw new TypeError("publisher admission requires a credential-free registry origin");
    origin = selected.origin;
  } else if (flags[at] === "--password-environment") at++;
  else if (flags[at] === "--token-from-npmrc") at += 2;
}
let selected = document;
if (Array.isArray(document.applications)) {
  const registries = document.applications.filter(application =>
    application.module === "@red-cup-engineering/npm-registry-serving-service/application" &&
    application.export === "npmRegistryHostedApplication"
      && (origin === undefined || application.configuration?.origin === origin));
  if (registries.length !== 1) throw new TypeError("the selected instance must identify one native npm registry application");
  selected = registries[0].configuration;
}
const configuration = validatedConfiguration(selected);
if (origin !== undefined && configuration.origin !== origin) throw new TypeError("the registry configuration differs from the selected publisher origin");
const home = value => (isAbsolute(value) ? value : resolve(homedir(), value));
const htpasswd = home(configuration.htpasswd), tokens = configuration.tokens ? home(configuration.tokens) : join(dirname(htpasswd), "tokens.jsonl");
let hash = "!", passwordFrom, token;
for (let at = 0; at < flags.length; at++) {
  if (flags[at] === "--origin") {
    at++;
  } else if (flags[at] === "--password-environment") {
    const value = process.env[flags[++at]];
    if (!value) throw new TypeError("the named environment variable is empty");
    hash = bcrypt.hashSync(value, 12); passwordFrom = "environment";
  } else if (flags[at] === "--token-from-npmrc") {
    const text = await readFile(flags[++at], "utf8"), host = flags[++at];
    const line = text.split("\n").find(entry => entry.startsWith(`//${host}/:_authToken=`));
    token = line?.slice(line.indexOf("=") + 1).trim();
    if (!token?.startsWith(TOKEN_PREFIX)) throw new TypeError("the .npmrc holds no registry sign-in token for that host");
  } else throw new TypeError("unknown option " + flags[at]);
}
await mkdir(dirname(htpasswd), { recursive: true, mode: 0o700 });
const existing = await readFile(htpasswd, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
const lines = existing.split("\n").filter(line => line !== "" && line.split(":")[0] !== user);
const partial = `${htpasswd}.${randomUUID()}.partial`;
await writeFile(partial, [...lines, `${user}:${hash}`].join("\n") + "\n", { mode: 0o600, flag: "wx" });
await rename(partial, htpasswd);
if (token) {
  const at = new Date().toISOString();
  await appendFile(tokens, JSON.stringify({ e: `npm-token:${createHash("sha256").update(token, "utf8").digest("base64url")}`, a: "npm.token", v: { user, created: at }, t: at }) + "\n", { mode: 0o600 });
}
process.stdout.write(JSON.stringify({ admitted: user, password: passwordFrom ?? "none", tokenRegistered: Boolean(token), htpasswd, tokens }) + "\n");
