import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

// A registry index (.verdaccio-db.json's `list`) and a package's own dist
// address are both *claims* of custody. Storage — the package.json's
// _attachments catalog plus the bytes actually sitting next to it — is the
// only ground truth. This module never trusts a claim it can re-measure.
export const DEFECT_KINDS = Object.freeze({
  DANGLING_CUSTODY: "dangling-custody",
  UNLISTED_CUSTODY: "unlisted-custody",
  UNRESOLVABLE_ARTIFACT_ADDRESS: "unresolvable-artifact-address",
  CORRUPT_ARTIFACT: "corrupt-artifact",
});

function defectId(kind, packageSurface, detailKey) {
  return sha256Hex(`${kind}:${packageSurface}:${detailKey ?? ""}`);
}

function packageDirectory(storageRoot, name) {
  return join(storageRoot, ...name.split("/"));
}

function ownedScopeOf(name, ownedScopes) {
  const match = /^@([^/]+)\//u.exec(name);
  return match !== null && ownedScopes.has(match[1]) ? match[1] : null;
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function measureBytes(bytes) {
  return Object.freeze({
    bytes: bytes.byteLength,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  });
}

function tarballFilename(tarballUrl) {
  if (typeof tarballUrl !== "string" || tarballUrl === "") return null;
  const slash = tarballUrl.lastIndexOf("/");
  try {
    return decodeURIComponent(tarballUrl.slice(slash + 1));
  } catch {
    return null;
  }
}

// Walks only `ownedScopes`. Scopes verdaccio proxies from an uplink
// legitimately hold partial history — only the tarballs a client actually
// requested get cached locally — so absence there is normal, not a defect.
// Only scopes this registry is the origin for owe a complete custody chain.
export async function assayRegistryCustody({ storageRoot, ownedScopes }) {
  if (typeof storageRoot !== "string" || storageRoot === "") throw new TypeError("`storageRoot` must be a non-empty string");
  const scopes = new Set(ownedScopes ?? []);
  if (scopes.size === 0) throw new TypeError("`ownedScopes` must name at least one owned scope");

  const dbPath = join(storageRoot, ".verdaccio-db.json");
  const db = await readJsonIfPresent(dbPath);
  if (db === null || !Array.isArray(db.list)) throw new Error(`registry index is absent or malformed: ${dbPath}`);
  const indexed = new Set(db.list);

  const defects = [];
  function report(kind, packageSurface, detail) {
    defects.push(Object.freeze({
      id: defectId(kind, packageSurface, JSON.stringify(detail)),
      kind,
      packageSurface,
      detail: Object.freeze({ ...detail }),
    }));
  }

  for (const name of indexed) {
    if (ownedScopeOf(name, scopes) === null) continue;
    const packageDir = packageDirectory(storageRoot, name);
    const packument = await readJsonIfPresent(join(packageDir, "package.json"));
    if (packument === null) {
      report(DEFECT_KINDS.DANGLING_CUSTODY, name, {
        reason: "registry index lists this package; no package metadata is stored on disk",
      });
      continue;
    }
    const attachments = packument._attachments ?? {};
    for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
      const surface = `${name}@${version}`;
      const dist = manifest?.dist ?? {};
      const filename = tarballFilename(dist.tarball);
      if (filename === null || !Object.hasOwn(attachments, filename)) {
        report(DEFECT_KINDS.UNRESOLVABLE_ARTIFACT_ADDRESS, surface, {
          reason: "the version's dist.tarball address names a file the package's own attachment catalog does not list",
          tarball: dist.tarball ?? null,
          attachments: Object.keys(attachments).sort(),
        });
        continue;
      }
      const artifactPath = join(packageDir, filename);
      let bytes;
      try {
        bytes = await readFile(artifactPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        report(DEFECT_KINDS.UNRESOLVABLE_ARTIFACT_ADDRESS, surface, {
          reason: "the attachment catalog names a file that is not present in storage",
          filename,
        });
        continue;
      }
      const measured = measureBytes(bytes);
      const mismatches = ["shasum", "integrity"].filter(
        (field) => dist[field] != null && dist[field] !== measured[field],
      );
      if (mismatches.length > 0) {
        report(DEFECT_KINDS.CORRUPT_ARTIFACT, surface, {
          reason: "stored artifact bytes do not hash to the package's own recorded digest",
          mismatches,
          recorded: { shasum: dist.shasum ?? null, integrity: dist.integrity ?? null },
          measured,
        });
      }
    }
  }

  for (const scope of scopes) {
    const scopeDir = join(storageRoot, `@${scope}`);
    if (!(await isDirectory(scopeDir))) continue;
    for (const entry of await readdir(scopeDir)) {
      const name = `@${scope}/${entry}`;
      if (indexed.has(name)) continue;
      const entryDir = join(scopeDir, entry);
      if (!(await isDirectory(entryDir))) continue;
      const packument = await readJsonIfPresent(join(entryDir, "package.json"));
      if (packument === null) continue;
      report(DEFECT_KINDS.UNLISTED_CUSTODY, name, {
        reason: "package metadata is stored on disk; the registry index does not list it",
      });
    }
  }

  defects.sort((a, b) => a.packageSurface.localeCompare(b.packageSurface) || a.kind.localeCompare(b.kind));
  return Object.freeze({
    storageRoot,
    ownedScopes: Object.freeze([...scopes].sort()),
    defects: Object.freeze(defects),
  });
}
