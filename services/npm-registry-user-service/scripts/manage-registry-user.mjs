#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { addUser, listUsers, removeUser } from "../src/htpasswd.mjs";

const [htpasswdPath, action, user] = process.argv.slice(2);
if (!htpasswdPath || !["list", "add", "remove"].includes(action ?? "")) {
  process.stderr.write(
    "usage: manage-registry-user <htpasswd-path> list\n" +
    "       manage-registry-user <htpasswd-path> add <user>     (password from REGISTRY_USER_PASSWORD)\n" +
    "       manage-registry-user <htpasswd-path> remove <user>\n",
  );
  process.exit(2);
}

const content = await readFile(htpasswdPath, "utf8").catch(() => "");

if (action === "list") {
  process.stdout.write(JSON.stringify(listUsers(content), null, 2) + "\n");
  process.exit(0);
}

if (user === undefined) {
  process.stderr.write(`${action} requires a user name\n`);
  process.exit(2);
}

let result;
if (action === "add") {
  const password = process.env.REGISTRY_USER_PASSWORD;
  if (!password) {
    process.stderr.write("set REGISTRY_USER_PASSWORD in the environment; passwords are not taken as arguments\n");
    process.exit(2);
  }
  result = addUser(content, user, password);
} else {
  result = removeUser(content, user);
}

if (result.judgment !== null) {
  process.stdout.write(JSON.stringify(result.judgment, null, 2) + "\n");
  process.exit(1);
}
await writeFile(htpasswdPath, result.content, "utf8");
process.stdout.write(JSON.stringify({ action, user, users: listUsers(result.content) }, null, 2) + "\n");
