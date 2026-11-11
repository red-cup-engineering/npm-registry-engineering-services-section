import { createHash } from "node:crypto";
import { link, readFile } from "node:fs/promises";
import { join } from "node:path";

// The retired publisher wrote npm's scoped attachment key below the package
// directory. Recover one explicitly named release, without replacing metadata
// or bytes. The published digest, rather than the old filename, admits it.
export async function repairScopedPublicationArtifact({ storage, name, version }) {
  if (typeof storage !== "string" || !storage.startsWith("/") || !/^@[a-z0-9-]+\/[a-z0-9._-]+$/u.test(name) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version)) throw new TypeError("absolute storage and one exact scoped release required");
  const directory = join(storage, name);
  const packument = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const manifest = packument.versions?.[version];
  if (packument.name !== name || manifest?.name !== name || manifest.version !== version) throw new Error("stored release identity differs");
  const leaf = `${name.split("/").pop()}-${version}.tgz`;
  if (decodeURIComponent(new URL(manifest.dist.tarball).pathname.split("/").pop()) !== leaf) throw new Error("published artifact identity differs");
  const source = join(directory, `${name}-${version}.tgz`);
  const bytes = await readFile(source);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (manifest.dist.integrity !== integrity) throw new Error("retained artifact differs from published SHA-512");
  const destination = join(directory, leaf);
  let changed = true;
  try { await link(source, destination); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await readFile(destination)).equals(bytes)) throw new Error("canonical artifact already contains different bytes");
    changed = false;
  }
  return { name, version, integrity, changed };
}
