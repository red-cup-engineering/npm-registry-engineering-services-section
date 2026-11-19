import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {isAbsolute, join, resolve} from "node:path";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

const worker = fileURLToPath(new URL("./guix-archive-registration.scm", import.meta.url));
const storeArchive = /^\/gnu\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-npm-registry-archive\.tgz$/u;

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    throw new TypeError(`${label} must be an absolute canonical path`);
  }
  return value;
}

/** Register exact archives in Guix. The caller owns allocation and collection roots. */
export function createGuixArchiveRegistrar({guix = "/usr/local/bin/guix"} = {}) {
  absolutePath(guix, "Guix program");
  let session;
  let nextId = 0;
  let closing;

  function open() {
    const child = spawn(guix, ["repl", "-q", "--", worker], {stdio: ["pipe", "pipe", "pipe"]});
    const pending = new Map();
    const result = {child, pending, failure: null, exited: null};
    let stderr = "";
    function fail(error) {
      result.failure = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    }

    child.stderr.setEncoding("utf8").on("data", chunk => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    result.exited = new Promise(done => {
      child.once("close", (status, signal) => {
        if (pending.size > 0) {
          fail(new Error(`Guix archive registration stopped (${signal ?? status}): ${stderr.trim()}`));
        }
        if (session === result) session = undefined;
        done();
      });
    });

    const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
    lines.on("line", line => {
      try {
        const answer = JSON.parse(line);
        const waiter = pending.get(answer.id);
        const success = typeof answer.archive === "string" && storeArchive.test(answer.archive);
        const refusal = typeof answer.error === "string" && answer.error.length > 0;
        if (!waiter || success === refusal) throw new Error("invalid Guix archive response");
        pending.delete(answer.id);
        if (success) waiter.resolve(answer.archive);
        else waiter.reject(new Error(answer.error));
      } catch (error) {
        fail(error);
        child.kill();
      }
    });
    return result;
  }

  return Object.freeze({
    async register(sourceFile, permanentRootSymlink) {
      if (closing) throw new Error("Guix archive registrar is closed");
      const file = absolutePath(sourceFile, "archive source");
      const root = absolutePath(permanentRootSymlink, "archive collector root");
      const active = session ??= open();
      if (active.failure) throw active.failure;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        active.pending.set(id, {resolve, reject});
        active.child.stdin.write(`${JSON.stringify({id, file, root})}\n`, error => {
          if (error && active.pending.delete(id)) reject(error);
        });
      });
    },
    close() {
      if (closing) return closing;
      const active = session;
      if (active) active.child.stdin.end();
      closing = active?.exited ?? Promise.resolve();
      return closing;
    },
  });
}

/** The original archive admission and exact-byte check, shared by both serving entrances. */
export function createGuixArchiveStorage({storage, roots, guix} = {}) {
  absolutePath(storage, "registry storage");
  absolutePath(roots, "archive collector directory");
  const registrar = createGuixArchiveRegistrar({guix});
  return Object.freeze({
    async storeArchive(bytes) {
      await mkdir(storage, {recursive: true});
      await mkdir(roots, {recursive: true, mode: 0o755});
      const work = await mkdtemp(join(storage, ".archive-"));
      const digest = createHash("sha256").update(bytes).digest("hex");
      try {
        const file = join(work, "archive.tgz");
        await writeFile(file, bytes, {flag: "wx", mode: 0o600});
        const archive = await registrar.register(file, join(roots, digest + ".tgz"));
        if (!(await readFile(archive)).equals(bytes)) throw new Error("registered archive differs from its publication");
        return archive;
      } finally { await rm(work, {recursive: true}); }
    },
    close: () => registrar.close(),
  });
}
