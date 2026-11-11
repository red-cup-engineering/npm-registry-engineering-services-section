import { createHash } from "node:crypto";

/**
 * htpasswd management in the {SHA} scheme (base64(sha1(password))) — one of
 * the schemes verdaccio-htpasswd verifies, and constructible with node:crypto
 * alone. Writing the file directly is deliberate: Verdaccio's `max_users`
 * gates only the signup API, not the file, so user administration stays a
 * local, auditable act.
 */
function shaEntry(password) {
  return "{SHA}" + createHash("sha1").update(password).digest("base64");
}

export function parseHtpasswd(content) {
  return Object.freeze(content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf(":");
      return Object.freeze({ user: line.slice(0, at), hash: line.slice(at + 1) });
    }));
}

export function listUsers(content) {
  return Object.freeze(parseHtpasswd(content).map((entry) => entry.user));
}

/** Returns {content, judgment}: refuses (unchanged content) on a duplicate or malformed name. */
export function addUser(content, user, password) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(user)) {
    return Object.freeze({ content, judgment: Object.freeze({ name: "user-name", value: "false", reason: "user names are lowercase alphanumerics plus ._- and start alphanumeric", path: user }) });
  }
  if (listUsers(content).includes(user)) {
    return Object.freeze({ content, judgment: Object.freeze({ name: "user-exists", value: "false", reason: `user ${user} already present; remove first to rotate`, path: user }) });
  }
  const body = content.endsWith("\n") || content === "" ? content : content + "\n";
  return Object.freeze({ content: `${body}${user}:${shaEntry(password)}\n`, judgment: null });
}

export function removeUser(content, user) {
  const entries = parseHtpasswd(content);
  if (!entries.some((entry) => entry.user === user)) {
    return Object.freeze({ content, judgment: Object.freeze({ name: "user-unknown", value: "false", reason: `no user ${user} in file`, path: user }) });
  }
  const kept = entries.filter((entry) => entry.user !== user);
  return Object.freeze({ content: kept.map((entry) => `${entry.user}:${entry.hash}`).join("\n") + (kept.length > 0 ? "\n" : ""), judgment: null });
}

export function verifyUser(content, user, password) {
  const entry = parseHtpasswd(content).find((candidate) => candidate.user === user);
  if (entry === undefined) return false;
  return entry.hash.startsWith("{SHA}") && entry.hash === shaEntry(password);
}
