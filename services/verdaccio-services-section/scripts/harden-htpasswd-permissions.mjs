#!/usr/bin/env node
// verdaccio-htpasswd writes data/htpasswd via plain fs.writeFile, so its
// mode is whatever the creating process's umask left behind — a group- or
// world-readable umask (e.g. 002) silently ships readable password hashes.
// Restrict it the same way the ActivityPub bearer-token loader treats any
// other private credential file: private regular file, or fail closed.

import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

const PRIVATE_FILE_MODE = 0o600;

export async function hardenPrivateFile(filePath) {
  let metadata;
  try {
    metadata = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { path: filePath, present: false, hardened: false };
    throw error;
  }
  if (!metadata.isFile()) throw new TypeError(`${filePath} must be one regular file`);
  if ((metadata.mode & 0o077) === 0) return { path: filePath, present: true, hardened: false };
  await chmod(filePath, PRIVATE_FILE_MODE);
  return { path: filePath, present: true, hardened: true };
}

const HTPASSWD_PATH = path.resolve(import.meta.dirname, "../data/htpasswd");

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "harden-htpasswd-permissions", description: "hardenPrivateFile — the harden-htpasswd-permissions operation.", operation: hardenPrivateFile }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
