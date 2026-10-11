import { planZeroMajorVersionMap, rewriteZeroMajorCarrier } from "./zero-major-version-reset.mjs";
const object = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const mapped = (maps, name, version) => maps.get(name)?.get(version) ?? version;

export function planVerdaccioZeroMajorVersionReset(packuments) {
  const maps = new Map();
  for (const packument of packuments) {
    if (!object(packument) || typeof packument.name !== "string" || !object(packument.versions)) throw new TypeError("each Verdaccio packument requires name and versions");
    maps.set(packument.name, new Map(planZeroMajorVersionMap(Object.keys(packument.versions)).map(({ from, to }) => [from, to])));
  }
  return Object.freeze({ profile: "org.561-group.verdaccio-zero-major-version-reset.v1", maps, mappings: Object.freeze([...maps].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, versions]) => [...versions].map(([from, to]) => Object.freeze({ name, from, to })))) });
}

/** Requires newly packed tarball evidence for each identity or dependency rewrite. */
export function rewriteVerdaccioPackument(packument, maps, { artifacts = new Map() } = {}) {
  if (!object(packument) || typeof packument.name !== "string" || !object(packument.versions)) throw new TypeError("packument requires name and versions");
  const next = structuredClone(packument), versions = {}, renamed = new Map();
  for (const [from, manifest] of Object.entries(packument.versions)) {
    const to = mapped(maps, packument.name, from), carrier = rewriteZeroMajorCarrier({ manifest }, maps), rewritten = carrier.manifest;
    rewritten.version = to;
    if (typeof rewritten._id === "string") rewritten._id = rewritten._id.replace(`${packument.name}@${from}`, `${packument.name}@${to}`);
    if (to !== from || carrier.dependencyEdits.length) {
      const artifact = artifacts.get(`${packument.name}\u0000${from}`);
      if (!artifact || artifact.version !== to || typeof artifact.filename !== "string" || typeof artifact.tarball !== "string" || typeof artifact.integrity !== "string" || typeof artifact.shasum !== "string") throw new Error(`rewritten ${packument.name}@${from} requires staged tarball integrity evidence`);
      rewritten.dist = { ...(rewritten.dist ?? {}), tarball: artifact.tarball, integrity: artifact.integrity, shasum: artifact.shasum };
      delete rewritten.dist.signatures;
      delete rewritten.dist.attestations;
      const old = typeof manifest.dist?.tarball === "string" ? manifest.dist.tarball.split("/").at(-1) : null;
      if (old) renamed.set(old, artifact);
    }
    if (Object.hasOwn(versions, to)) throw new Error(`version reset collides within ${packument.name}: ${from} targets ${to}`);
    versions[to] = rewritten;
  }
  next.versions = versions;
  if (object(next.time)) next.time = Object.fromEntries(Object.entries(next.time).map(([version, value]) => [mapped(maps, packument.name, version), value]));
  if (object(next["dist-tags"])) next["dist-tags"] = Object.fromEntries(Object.entries(next["dist-tags"]).map(([tag, version]) => [tag, mapped(maps, packument.name, version)]));
  for (const field of ["_attachments", "_distfiles"]) if (object(next[field])) {
    next[field] = Object.fromEntries(Object.entries(next[field]).map(([filename, value]) => {
      const artifact = renamed.get(filename);
      return artifact ? [artifact.filename, { ...(object(value) ? value : {}), shasum: artifact.shasum, version: artifact.version }] : [filename, value];
    }));
  }
  return Object.freeze(next);
}
