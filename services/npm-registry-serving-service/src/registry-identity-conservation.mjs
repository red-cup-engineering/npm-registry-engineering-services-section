import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import semver from "semver";
import { canonicalJson } from "@red-cup-engineering/json-engineering-services-section/canonical-json";
import { admittedName, parsePackagePath } from "./prepared-publication.mjs";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const key = (name, version) => JSON.stringify([name, version]);
const manifestDigest = value => createHash("sha256").update(canonicalJson(value)).digest("hex");
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

/** Restrictive observations; none of these records grants publisher authority. */
export function registryIdentityConservation(input, configuration) {
  const policy = input ?? { version: 1, conflicts: [], reservations: [] };
  if (!exactKeys(policy, ["version", "conflicts", "reservations"]) || policy.version !== 1
      || !Array.isArray(policy.conflicts) || !Array.isArray(policy.reservations))
    throw new TypeError("registry identity conservation needs typed conflict/reservation records");
  const conflicts = new Map(), reservations = new Map(), artifacts = new Map();
  const privateName = name => configuration.privateNames.includes(name)
    || configuration.privateScopes.some(scope => name.startsWith(scope + "/"));
  function subject(item) {
    if (!admittedName(item?.name) || !privateName(item.name) || typeof item.version !== "string"
        || semver.valid(item.version) !== item.version)
      throw new TypeError("identity observation has another house package/version");
    if (!exactKeys(item.evidence, ["recordSha256", "work"]) || !/^[a-f0-9]{64}$/u.test(item.evidence.recordSha256)
        || typeof item.evidence.work !== "string" || !item.evidence.work.startsWith("https://github.com/"))
      throw new TypeError("identity observation needs its received evidence commitment and governing work");
  }
  function identity(item, observed) {
    if (!exactKeys(observed, ["authority", "manifestSha256", "integrity", "gitHead", "tarball"])
        || !["native", "canonical-r2"].includes(observed.authority)
        || !/^[a-f0-9]{64}$/u.test(observed.manifestSha256)
        || !(observed.gitHead === null || /^[a-f0-9]{40}$/u.test(observed.gitHead))
        || typeof observed.integrity !== "string" || !observed.integrity.startsWith("sha512-"))
      throw new TypeError("identity observation is incomplete");
    const encoded = observed.integrity.slice(7), bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== 64 || bytes.toString("base64") !== encoded) throw new TypeError("identity observation needs an exact SHA512 commitment");
    let url, parsed;
    try { url = new URL(observed.tarball); parsed = parsePackagePath(url.pathname); }
    catch { throw new TypeError("identity observation has no qualified archive URL"); }
    if (url.origin !== configuration.origin || parsed.name !== item.name || parsed.rest.length !== 2
        || parsed.rest[0] !== "-" || !parsed.rest[1].endsWith(".tgz") || url.search || url.hash || url.username || url.password)
      throw new TypeError("identity observation has another archive authority/path");
    return { ...observed, archiveFile: parsed.rest[1] };
  }
  for (const item of policy.conflicts) {
    subject(item);
    if (!exactKeys(item, ["name", "version", "evidence", "identities"]) || !Array.isArray(item.identities) || item.identities.length !== 2)
      throw new TypeError("conflict must retain both original identities");
    const identities = item.identities.map(value => identity(item, value));
    if (new Set(identities.map(value => value.authority)).size !== 2
        || identities.every(value => value.manifestSha256 === identities[0].manifestSha256
          && value.integrity === identities[0].integrity && value.gitHead === identities[0].gitHead))
      throw new TypeError("conflict does not distinguish native and canonical identities");
    const entry = structuredClone({ ...item, identities });
    if (conflicts.has(key(item.name, item.version))) throw new TypeError("duplicate immutable conflict observation");
    conflicts.set(key(item.name, item.version), entry);
    for (const value of identities) artifacts.set(key(item.name, value.archiveFile), entry);
  }
  for (const item of policy.reservations) {
    subject(item);
    if (!exactKeys(item, ["name", "version", "evidence", "identity"])) throw new TypeError("native reservation needs one exact observed identity");
    const observed = identity(item, item.identity), k = key(item.name, item.version);
    if (observed.authority !== "native" || observed.gitHead === null || reservations.has(k) || conflicts.has(k)) throw new TypeError("native reservation overlaps or lacks its original source/authority");
    reservations.set(k, structuredClone({ ...item, identity: observed }));
  }
  const matches = (manifest, observed) => record(manifest) && (manifest.gitHead ?? null) === observed.gitHead
    && manifest.dist?.integrity === observed.integrity && manifest.dist?.tarball === observed.tarball
    && manifestDigest(manifest) === observed.manifestSha256;
  return Object.freeze({
    conflict: (name, version) => conflicts.get(key(name, version)),
    artifactConflict: (name, file) => artifacts.get(key(name, file)),
    reservation: (name, version) => reservations.get(key(name, version)),
    matches,
    /** Whether project(name, …) can change this package's document: only a package with a held conflict. */
    projects: name => [...conflicts.values()].some(item => item.name === name),
    project(name, document) {
      const held = [...conflicts.values()].filter(item => item.name === name);
      if (!held.length) return document;
      const versions = { ...document.versions }, tags = { ...(document["dist-tags"] ?? {}) };
      const time = record(document.time) ? { ...document.time } : document.time;
      for (const item of held) {
        const observed = item.identities.find(value => value.authority === "canonical-r2");
        if (Object.hasOwn(versions, item.version) && !matches(versions[item.version], observed))
          throw new Error("stored conflicting identity drifted from its received observation");
        delete versions[item.version];
        if (record(time)) delete time[item.version];
        for (const [tag, version] of Object.entries(tags)) if (version === item.version) delete tags[tag];
      }
      return { ...document, versions, "dist-tags": tags, ...(time === undefined ? {} : { time }),
        "x-561-registry-conflicts": held.map(({ name: _name, version, evidence, identities }) => ({
          version, evidence, identities: identities.map(({ archiveFile: _file, ...observed }) => observed),
        })) };
    },
  });
}
