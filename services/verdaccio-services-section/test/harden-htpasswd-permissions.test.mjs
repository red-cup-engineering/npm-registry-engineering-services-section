import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { hardenPrivateFile } from "../scripts/harden-htpasswd-permissions.mjs";

// node:os tmpdir() resolves onto a Windows drvfs mount on this host, where
// chmod is a no-op and every file reports mode 0o777 regardless of what was
// requested. These assertions are about real POSIX permission bits, so they
// need a Linux-native temporary directory.
const tmpdir = () => "/tmp";

test("restricts a group- and world-readable credential file to 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "harden-htpasswd-"));
  try {
    const htpasswd = join(root, "htpasswd");
    await writeFile(htpasswd, "emsenn:$apr1$fixture\n", { mode: 0o664 });
    const result = await hardenPrivateFile(htpasswd);
    assert.deepEqual(result, { path: htpasswd, present: true, hardened: true });
    assert.equal((await stat(htpasswd)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves an already-private credential file untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "harden-htpasswd-"));
  try {
    const htpasswd = join(root, "htpasswd");
    await writeFile(htpasswd, "emsenn:$apr1$fixture\n", { mode: 0o600 });
    const result = await hardenPrivateFile(htpasswd);
    assert.deepEqual(result, { path: htpasswd, present: true, hardened: false });
    assert.equal((await stat(htpasswd)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("is a no-op before the registry's first adduser creates the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "harden-htpasswd-"));
  try {
    const result = await hardenPrivateFile(join(root, "htpasswd"));
    assert.deepEqual(result, { path: join(root, "htpasswd"), present: false, hardened: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a path that is not a regular file", async () => {
  const root = await mkdtemp(join(tmpdir(), "harden-htpasswd-"));
  try {
    await assert.rejects(() => hardenPrivateFile(root), TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
