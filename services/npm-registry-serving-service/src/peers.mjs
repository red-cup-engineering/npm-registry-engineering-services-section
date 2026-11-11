import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { DEPRECATION, DIST_TAG, PUBLICATION, artifactFile, legacyRows } from "./facts.mjs";
import { foldPackage, renderStoreLayout } from "./projection.mjs";
import { createR2S3Bucket } from "./r2-s3-bucket.mjs";

/**
 * Peers: where a node's registry store is filled from besides its own publications.
 *
 * Every node serves its own registry over its own store. No node, Worker or bucket is the canonical one: another
 * node's registry, or an object bucket holding packuments and tarballs, is a peer, a channel through which versions
 * reach this node. A peer is `{name, packument(name), artifact(name, file, dist)}`: the packument it holds for a
 * name (or undefined) and the bytes of one tarball (or undefined). What a peer says is received as facts, never
 * trusted: a tarball is kept only if its bytes are the integrity and shasum its packument advertised, and it is
 * named in the blob store by the NI address of its own bytes, so the same bytes from any peer are one blob.
 *
 * Receiving never replaces. A version this store already holds stays as it is; if a peer holds the same version
 * with other bytes, that is reported as a divergence for the two nodes to reconcile, not resolved by either. The
 * journal's own rule keeps a second publication of a version out of every document.
 */

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const measured = bytes => ({ integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"), shasum: createHash("sha1").update(bytes).digest("hex") });

/** A peer that is an object bucket laid out as the registry's R2 profile lays it: `<name>/index.json` and `<name>/-/<file>`. */
export function bucketPeer({ name = "bucket", bucket }) {
  return Object.freeze({
    name,
    async packument(packageName) {
      const object = await bucket.get(packageName + "/index.json");
      return object === null ? undefined : JSON.parse(Buffer.from(await object.arrayBuffer()).toString("utf8"));
    },
    async artifact(packageName, file) {
      const object = await bucket.get(packageName + "/-/" + file);
      return object === null ? undefined : Buffer.from(await object.arrayBuffer());
    },
  });
}

/** A peer that is another node's registry, read through the npm protocol it serves. */
export function registryPeer({ name, url, fetchImpl = fetch, timeoutMs = 30_000 }) {
  const base = new URL(url).origin;
  const path = (...segments) => base + "/" + segments.flatMap(segment => segment.split("/")).map(part => encodeURIComponent(part).replace(/^%40/u, "@")).join("/");
  const read = async address => {
    const reply = await fetchImpl(address, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (reply.status === 404) return undefined;
    if (!reply.ok) throw new Error(`peer ${name} answered ${reply.status} for ${address}`);
    return Buffer.from(await reply.arrayBuffer());
  };
  return Object.freeze({
    name,
    async packument(packageName) {
      const bytes = await read(path(packageName));
      return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
    },
    artifact: (packageName, file) => read(path(packageName, "-", file)),
  });
}

/** A peer from its declared specification and the process environment (credentials are named, never held, in a declaration). */
export function peerFromSpecification(specification, environment = process.env) {
  if (!record(specification) || typeof specification.name !== "string") throw new TypeError("a peer declares its name");
  if (specification.kind === "registry") return registryPeer({ name: specification.name, url: specification.url });
  if (specification.kind === "bucket") {
    const need = key => {
      const value = environment[specification[key]];
      if (typeof specification[key] !== "string" || !value) throw new TypeError(`peer ${specification.name} needs the environment variable named by ${key}`);
      return value;
    };
    return bucketPeer({ name: specification.name, bucket: createR2S3Bucket({
      accountId: specification.accountId ?? need("accountIdEnvironment"), bucket: specification.bucket,
      accessKeyId: need("accessKeyIdEnvironment"), secretAccessKey: need("secretAccessKeyEnvironment") }) });
  }
  throw new TypeError(`peer ${specification.name} is a registry or a bucket`);
}

/**
 * Receive from `peers`, in order, the versions of `name` the store does not hold, under the caller's hold on the
 * package's lock. A version's facts are always received; its tarball bytes are received now only if `eager(version)`,
 * else when first asked for (`receiveArtifactFromPeers`), so a node holds the bytes it uses and not every byte its
 * peers hold. `{name, status, received: [versions], missing, mismatched, diverged, quarantined, peers}`; status is
 * `absent` when no peer holds the name, `unchanged` when the store already has every version a peer offers.
 *
 * A version `quarantined(version)` names (registry-identity-conservation.mjs: a conflict between immutable
 * identities) is neither received nor reported as diverged: whichever identity a peer offers, it is listed in
 * `quarantined` and nothing of it, nor a dist-tag naming it, is written. A version the store already holds stays.
 * A peer's `x-561-registry-conflicts` is its own derived view of that quarantine, never a fact to store.
 */
export async function receivePeersHeld(store, name, peers, { origin, eager = () => false, quarantined = () => false }) {
  const report = { name, status: "absent", received: [], missing: [], mismatched: [], diverged: [], quarantined: [] };
  for (const peer of peers) {
    let packument;
    try { packument = await peer.packument(name); } catch (error) { report.error = `${peer.name}: ${error.message}`; continue; }
    if (!record(packument) || (packument.name !== undefined && packument.name !== name) || !record(packument.versions)) continue;
    const current = await store.read(name);
    const state = current === undefined ? undefined : foldPackage(name, current.rows);
    const offered = Object.entries(packument.versions).filter(([version, manifest]) => {
      if (!record(manifest)) return false;
      if (!quarantined(version)) return true;
      if (!report.quarantined.includes(version)) report.quarantined.push(version);
      return false;
    });
    const fresh = offered.filter(([version]) => state === undefined || !state.versions.has(version));
    for (const [version, manifest] of offered) {
      const held = state?.versions.get(version);
      if (held && held.manifest?.dist?.integrity !== undefined && manifest.dist?.integrity !== undefined && held.manifest.dist.integrity !== manifest.dist.integrity)
        report.diverged.push({ version, peer: peer.name, held: held.manifest.dist.integrity, offered: manifest.dist.integrity });
    }
    if (report.status === "absent") report.status = "unchanged";
    if (fresh.length === 0) continue;
    const accepted = {}, artifacts = new Map();
    for (const [version, manifest] of fresh) {
      const file = artifactFile(name, version, manifest.dist);
      if (manifest.dist?.integrity === undefined && manifest.dist?.shasum === undefined) { report.mismatched.push(version); continue; }
      if (!eager(version)) { accepted[version] = manifest; continue; }
      let bytes;
      try { bytes = await peer.artifact(name, file, manifest.dist); } catch (error) { report.error = `${peer.name}: ${error.message}`; }
      if (bytes === undefined) { report.missing.push(version); continue; }
      const digests = measured(bytes);
      if ((manifest.dist?.integrity !== undefined && manifest.dist.integrity !== digests.integrity)
          || (manifest.dist?.shasum !== undefined && manifest.dist.shasum !== digests.shasum)) { report.mismatched.push(version); continue; }
      artifacts.set(file, { ni: await store.storeBlob(bytes), size: bytes.length });
      accepted[version] = manifest;
    }
    const versions = Object.keys(accepted);
    if (versions.length === 0) continue;
    const time = record(packument.time) ? Object.fromEntries(Object.entries(packument.time).filter(([key]) => key === "modified" || key === "created" || versions.includes(key))) : undefined;
    const { "x-561-registry-conflicts": _derivedView, ...offeredPackument } = packument;
    const tags = record(packument["dist-tags"]) ? Object.fromEntries(Object.entries(packument["dist-tags"]).filter(([, version]) => !quarantined(version))) : packument["dist-tags"];
    const rows = legacyRows(name, { ...offeredPackument, "dist-tags": tags, versions: accepted, ...(time ? { time } : {}) }, { artifactOf: file => artifacts.get(file) });
    // A name this store already holds keeps its own tags, readme and fields; what a peer adds is versions and their deprecations.
    const added = state === undefined ? rows : rows.filter(row => row.a === PUBLICATION || row.a === DEPRECATION
      || (row.a === DIST_TAG && !state.tags.has(row.v.tag)));
    await store.append(name, added);
    const written = await store.read(name);
    await store.materialize(name, renderStoreLayout(foldPackage(name, written.rows), { origin, revision: `${written.rows.length}-${written.digest.slice(0, 32)}` }));
    report.status = "received"; report.received.push(...versions); (report.peers ??= []).push(peer.name);
  }
  return report;
}

/** The same under the package's own lock. */
export const receivePeers = (store, name, peers, options) => store.lock(name, () => receivePeersHeld(store, name, peers, options));

/**
 * The bytes of one house version's tarball, from the first peer that holds the advertised bytes, kept in the blob
 * store under their NI address and named at the package's leaf. True when the store has them afterwards.
 */
export async function receiveArtifactFromPeers(store, name, file, dist, peers) {
  for (const peer of peers) {
    let bytes;
    try { bytes = await peer.artifact(name, file, dist); } catch { continue; }
    if (bytes === undefined) continue;
    const digests = measured(bytes);
    if ((dist?.integrity !== undefined && dist.integrity !== digests.integrity) || (dist?.shasum !== undefined && dist.shasum !== digests.shasum)
        || (dist?.integrity === undefined && dist?.shasum === undefined)) continue;
    await store.placeLeaf(name, file, await store.storeBlob(bytes), bytes);
    return true;
  }
  return false;
}
