import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { foldPackage } from "./projection.mjs";

/**
 * Carry to the canonical receiver the versions of `name` this store holds and the receiver does not: each as the
 * receiver's ordinary one-version publication of its exact stored manifest and archive bytes, with no dist-tag, so
 * no tag moves and nothing is repacked or minted. The receiver's own checks decide every version (immutable
 * identity, reservations, conflicts, the publication gate). A version the receiver holds under other bytes is
 * reported as diverged and never sent. `{name, carried, refused, diverged, unreadable}`.
 */
export async function carryHeld(store, name, { canonical, authorization, fetch: fetchImpl = fetch }) {
  const report = { name, carried: [], refused: [], diverged: [], unreadable: [] };
  const read = await store.read(name);
  if (read === undefined) return report;
  const state = foldPackage(name, read.rows), url = canonical + "/" + encodeURIComponent(name);
  const reply = await fetchImpl(new Request(url, { headers: { accept: "application/json" } }));
  if (reply.status !== 200 && reply.status !== 404) throw new Error(`${name}: the canonical receiver answered ${reply.status}`);
  const held = reply.status === 200 ? (await reply.json()).versions ?? {} : {};
  for (const [version, entry] of state.versions) {
    const integrity = entry.manifest?.dist?.integrity;
    if (Object.hasOwn(held, version)) {
      if (integrity !== undefined && held[version].dist?.integrity !== undefined && held[version].dist.integrity !== integrity)
        report.diverged.push({ version, held: integrity, canonical: held[version].dist.integrity });
      continue;
    }
    const located = await store.artifactPath(name, entry.artifact);
    const bytes = located === undefined ? undefined : await readFile(located.path);
    if (bytes === undefined || integrity === undefined
        || "sha512-" + createHash("sha512").update(bytes).digest("base64") !== integrity) { report.unreadable.push(version); continue; }
    // The npm wire form names the attached archive by its canonical file under the receiver; the receiver rewrites
    // the URL to its own origin. The manifest's identity (integrity, shasum, fields) is the stored one.
    const file = `${name.split("/").pop()}-${version}.tgz`;
    const manifest = { ...entry.manifest, dist: { ...entry.manifest.dist, tarball: `${canonical}/${name}/-/${file}` } };
    const body = { _id: name, name, "dist-tags": {}, versions: { [version]: manifest },
      _attachments: { [file]: { content_type: "application/octet-stream", data: bytes.toString("base64"), length: bytes.length } } };
    const sent = await fetchImpl(new Request(url, { method: "PUT", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const answer = await sent.json().catch(() => ({}));
    if (sent.status === 200 || sent.status === 201) report.carried.push(version);
    else report.refused.push({ version, status: sent.status, error: answer.error ?? answer.reason ?? null });
  }
  return report;
}
