import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { observeDiskPackages } from "@red-cup-engineering/disk-package-observation-app";

const OBSERVATION_TYPE = "RegistryDriftObservation";
const RECEIPT_TYPE = "SemioticVoxelPackageRegistryReceipt";
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const VERDICTS = ["current", "stale-manifest", "unpublished", "source-missing"];

function registryFace(registryUrl) {
  const url = new URL(registryUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("registryUrl must be HTTP(S)");
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

// Same protocol every reader of this registry speaks: GET /{encodeURIComponent(name)}
// for a whole packument, single percent-encoding, dist-tags.latest for "the"
// published version. GET /registry-receipt.json for the build's own manifest
// of every name it has ever published, which is the only way to learn about a
// name the disk walk never mentions (the source-missing case).
async function fetchJson(path, { registryUrl, fetchImplementation }) {
  const face = registryFace(registryUrl);
  const response = await fetchImplementation(new URL(path, face));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`registry face returned HTTP ${response.status} for ${path}`);
  return JSON.parse(Buffer.from(await response.arrayBuffer()).toString("utf8"));
}

function isWorkspaceProtocol(constraint) {
  return typeof constraint === "string" && constraint.startsWith("workspace:");
}

// A dependency comparison is a set comparison first (renamed/added/removed
// providers) and a pin comparison second — but only for pins the source
// wrote as a literal, since workspace: pins resolve to whatever the base
// registry's latest happened to be at build time and are never expected to
// read back as the same string.
function compareDependencyField(field, sourceDeps, publishedDeps) {
  const source = sourceDeps ?? {};
  const published = publishedDeps ?? {};
  const drift = [];
  for (const name of Object.keys(source).sort()) {
    if (!(name in published)) {
      drift.push({ field, name, reason: "missing-in-published", source: source[name] });
      continue;
    }
    if (isWorkspaceProtocol(source[name])) continue;
    if (source[name] !== published[name]) {
      drift.push({ field, name, reason: "pin-mismatch", source: source[name], published: published[name] });
    }
  }
  for (const name of Object.keys(published).sort()) {
    if (!(name in source)) drift.push({ field, name, reason: "missing-in-source", published: published[name] });
  }
  return drift;
}

function dependencyDrift(sourceManifest, publishedManifest) {
  return DEPENDENCY_FIELDS.flatMap((field) => compareDependencyField(field, sourceManifest[field], publishedManifest[field]));
}

// Composes the disk observation actuator (walk + manifest read) with the
// registry's own packument protocol: for every package the source tree
// declares, ask the registry what it currently publishes for that name and
// diff the two. A name the registry knows that the disk walk never surfaced
// is reported the other direction, as source-missing.
export async function observeRegistryDrift({ root, excludes = [], registryUrl, fetchImplementation = fetch } = {}) {
  if (typeof registryUrl !== "string" || !registryUrl) throw new TypeError("registryUrl is required");
  const disk = await observeDiskPackages({ root, excludes });

  const packumentCache = new Map();
  async function packument(name) {
    if (!packumentCache.has(name)) {
      packumentCache.set(name, await fetchJson(encodeURIComponent(name), { registryUrl, fetchImplementation }));
    }
    return packumentCache.get(name);
  }

  const findings = [];
  const sourceNames = new Set();
  for (const entry of disk.packages) {
    sourceNames.add(entry.name);
    const manifest = JSON.parse(await readFile(resolve(disk.root, entry.path), "utf8"));
    const meta = await packument(entry.name);

    if (meta === null) {
      findings.push(Object.freeze({
        name: entry.name, path: entry.path, sourceVersion: entry.version, publishedVersion: null,
        verdict: "unpublished", dependencyDrift: Object.freeze([]),
      }));
      continue;
    }
    const publishedVersion = meta["dist-tags"]?.latest ?? null;
    const publishedManifest = meta.versions?.[entry.version];
    if (publishedManifest === undefined || publishedManifest.name !== entry.name || publishedManifest.version !== entry.version) {
      findings.push(Object.freeze({
        name: entry.name, path: entry.path, sourceVersion: entry.version, publishedVersion,
        verdict: "unpublished", dependencyDrift: Object.freeze([]),
      }));
      continue;
    }
    const drift = dependencyDrift(manifest, publishedManifest);
    findings.push(Object.freeze({
      name: entry.name, path: entry.path, sourceVersion: entry.version, publishedVersion,
      verdict: drift.length > 0 ? "stale-manifest" : "current",
      dependencyDrift: Object.freeze(drift.map((d) => Object.freeze(d))),
    }));
  }

  // The registry's own receipt is the only listing of every name it has ever
  // published; a name that appears there but never turned up on the disk
  // walk is a package the source tree no longer carries at all.
  const receipt = await fetchJson("registry-receipt.json", { registryUrl, fetchImplementation });
  const receiptScopeNote = receipt !== null && receipt.type !== RECEIPT_TYPE ? "registry-receipt.json did not carry the expected receipt type" : null;
  const registryNames = receipt !== null && Array.isArray(receipt.packages)
    ? [...new Set(receipt.packages.map((entry) => entry.name))].sort()
    : [];
  for (const name of registryNames) {
    if (sourceNames.has(name)) continue;
    const meta = await packument(name);
    findings.push(Object.freeze({
      name, path: null, sourceVersion: null, publishedVersion: meta?.["dist-tags"]?.latest ?? null,
      verdict: "source-missing", dependencyDrift: Object.freeze([]),
    }));
  }

  findings.sort((a, b) => a.name.localeCompare(b.name) || VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict));

  const counts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, findings.filter((f) => f.verdict === verdict).length]));

  return Object.freeze({
    type: OBSERVATION_TYPE,
    root: disk.root,
    registry: registryFace(registryUrl),
    findings: Object.freeze(findings),
    diskDefects: disk.defects,
    receiptFound: receipt !== null,
    receiptScopeNote,
    counts: Object.freeze(counts),
  });
}
