import { createHash, randomBytes } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import bcrypt from "bcryptjs";

/**
 * Who may change the registry: the publishers in its htpasswd file (bcrypt), signing in as npm signs in.
 *
 * - Basic: the `username`/`_password` (or `_auth`) an .npmrc carries, checked against htpasswd on every request.
 * - Bearer: a token `npm login` obtained (`PUT /-/user/org.couchdb.user:<name>` with the publisher's password), the
 *   `_authToken` an .npmrc carries. Only a token's SHA-256 is kept, in an append-only JSONL file of EAVT rows beside
 *   htpasswd (`{e: "npm-token:<digest>", a: "npm.token", v: {user, created} | null, t}`); `npm logout` revokes it.
 *
 * Accounts are the operator's: the htpasswd file is re-read when it changes, and signing in never creates one.
 */
const TOKEN_ATTRIBUTE = "npm.token";
export const TOKEN_PREFIX = "hnr_";

export function createCredentials({ htpasswd, tokens, now = () => new Date() }) {
  const digest = (token) => createHash("sha256").update(token, "utf8").digest("base64url");
  const keyOf = async (path) => {
    try { const info = await stat(path); return `${info.ino}:${info.size}:${info.mtimeMs}`; }
    catch (error) { if (error.code === "ENOENT") return "absent"; throw error; }
  };

  let users = { key: undefined, hashes: new Map() };
  async function usersNow() {
    const key = await keyOf(htpasswd);
    if (key === users.key) return users.hashes;
    const text = key === "absent" ? "" : await readFile(htpasswd, "utf8");
    const hashes = new Map();
    // Verdaccio's lines may carry more fields (`user:hash:autocreated …`); the hash is the second.
    for (const line of text.split("\n")) {
      const [user, hash] = line.split(":");
      if (user && hash) hashes.set(user, hash.trim());
    }
    users = { key, hashes };
    return hashes;
  }
  /** The publisher whose password this is, or null. */
  async function verify(user, password) {
    if (typeof user !== "string" || typeof password !== "string") return null;
    const hash = (await usersNow()).get(user);
    if (!hash || !/^\$2[aby]\$/u.test(hash)) return null;
    return (await bcrypt.compare(password, hash.replace(/^\$2y\$/u, "$2a$"))) ? user : null;
  }

  let held = { key: undefined, owners: new Map() };
  async function tokensNow() {
    const key = await keyOf(tokens);
    if (key === held.key) return held.owners;
    const owners = new Map();
    const text = key === "absent" ? "" : await readFile(tokens, "utf8");
    for (const line of text.split("\n")) {
      if (!line.endsWith("}")) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.a !== TOKEN_ATTRIBUTE || typeof row.e !== "string") continue;
      if (row.v === null) owners.delete(row.e);
      else if (typeof row.v?.user === "string") owners.set(row.e, row.v.user);
    }
    held = { key, owners };
    return owners;
  }
  const entity = (token) => `npm-token:${digest(token)}`;
  /** A new token for a publisher. Only its digest is kept. */
  async function issue(user) {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const at = now().toISOString();
    await appendFile(tokens, `${JSON.stringify({ e: entity(token), a: TOKEN_ATTRIBUTE, v: { user, created: at }, t: at })}\n`, { mode: 0o600 });
    return token;
  }
  /** Revoke a token. */
  async function revoke(token) {
    await appendFile(tokens, `${JSON.stringify({ e: entity(token), a: TOKEN_ATTRIBUTE, v: null, t: now().toISOString() })}\n`, { mode: 0o600 });
  }
  /** The publisher a token signs in, or null. */
  async function bearer(token) {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
    const user = (await tokensNow()).get(entity(token));
    return user !== undefined && (await usersNow()).has(user) ? user : null;
  }

  /** The publisher a request is signed in as (Basic or Bearer), or null. */
  async function authenticated(request) {
    const header = request.headers.get("authorization") ?? "";
    const bearerToken = /^Bearer\s+(\S+)$/iu.exec(header);
    if (bearerToken) return bearer(bearerToken[1]);
    const basic = /^Basic\s+(\S+)$/iu.exec(header);
    if (!basic) return null;
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon > 0 ? verify(decoded.slice(0, colon), decoded.slice(colon + 1)) : null;
  }

  return Object.freeze({ authenticated, verify, issue, revoke, bearer });
}
