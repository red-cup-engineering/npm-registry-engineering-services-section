import { isDeepStrictEqual } from "node:util";
import { DEPRECATION, DIST_TAG, PUBLICATION, artifactFile, legacyRows, packageEntity, versionEntity } from "./facts.mjs";
import { foldPackage, renderFull, renderStoreLayout } from "./projection.mjs";

/**
 * Reception: writing down, as facts, what the store holds in its earlier layout.
 *
 * A package the earlier store wrote (`package.json`, no journal) is received whole: each version's tarball is adopted
 * into the blob store under its NI address (a hard link, not a copy) and checked against the integrity it was
 * advertised with; its facts are folded and rendered, and they are written only if that rendering serves everything
 * the earlier store served, field for field. A package that does not agree is left exactly as it was and reported.
 *
 * A package with a journal is reconciled with its `package.json`, which is this registry's projection of it but
 * which an earlier release (after a rollback) may have written to: a version found only there was published and is
 * received, never lost; tags and deprecations changed there after this registry last wrote it are received too.
 * The projection is then rewritten if it differs.
 */

const presentedLegacy = (name, packument, origin) => {
  const { _attachments, _distfiles, _uplinks, _rev, ...shown } = packument;
  const versions = {};
  for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
    const { deprecated, ...kept } = manifest;
    versions[version] = { ...kept, ...(deprecated ? { deprecated } : {}), dist: { ...manifest.dist, tarball: `${origin}/${name}/-/${artifactFile(name, version, manifest.dist)}` } };
  }
  return { ...shown, versions };
};

/** The top-level fields of what the earlier store served for `packument` that `rows` would not serve the same. */
export function disagreements(name, packument, rows, origin) {
  const served = renderFull(foldPackage(name, rows), { origin });
  return Object.entries(presentedLegacy(name, packument, origin)).filter(([key, value]) => !isDeepStrictEqual(value, served[key])).map(([key]) => key);
}

/** Adopt the tarballs of `versions` (name → stored manifest) into the blob store; `{artifacts, missing, mismatched,
 *  recovered}`. A tarball is measured as a stream and must match the digests it was advertised with. A scoped version
 *  the retired publisher left under npm's attachment key instead of its leaf is recovered from there when its bytes
 *  are the advertised ones (as repair-scoped-publication-artifact does), and linked at its leaf. */
async function adoptArtifacts(store, name, versions, { dryRun = false } = {}) {
  const artifacts = new Map(), missing = [], mismatched = [], recovered = [];
  for (const [version, manifest] of Object.entries(versions)) {
    const file = artifactFile(name, version, manifest?.dist);
    const leaf = await store.artifactPath(name, { file });
    const located = leaf ?? await store.scopedAttachmentPath(name, version);
    if (located === undefined) { missing.push(version); continue; }
    const dist = manifest?.dist ?? {};
    const advertised = (measured) => (dist.integrity === undefined || dist.integrity === measured.integrity)
      && (dist.shasum === undefined || dist.shasum === measured.shasum) && (dist.integrity !== undefined || dist.shasum !== undefined || leaf !== undefined);
    // Measure before adopting anything found off its leaf: only the advertised bytes are recovered.
    const measured = leaf === undefined ? await store.measure(located.path) : await store.adoptBlob(located.path, { link: !dryRun });
    if (!advertised(measured)) { mismatched.push(version); continue; }
    if (leaf === undefined) {
      if (!dryRun) { await store.adoptBlob(located.path); await store.linkLeaf(name, file, measured.ni); }
      recovered.push(version);
    }
    artifacts.set(file, { ni: measured.ni, size: measured.size });
  }
  return { artifacts, missing, mismatched, recovered };
}

const revisionOf = (read) => `${read.rows.length}-${read.digest.slice(0, 32)}`;

/** Receive one package, holding its lock already. Returns what was done; writes nothing when `dryRun`. */
export async function receiveHeld(store, name, { origin, dryRun = false, now = () => new Date() }) {
  const current = await store.read(name);
  if (current === undefined) return { name, status: "absent" };
  if (current.kind === "layout") {
    const { packument } = current;
    if (packument?.name !== undefined && packument.name !== name) return { name, status: "refused", disagreements: ["name"] };
    const { artifacts, missing, mismatched, recovered } = await adoptArtifacts(store, name, packument.versions ?? {}, { dryRun });
    const rows = legacyRows(name, packument, { artifactOf: (file) => artifacts.get(file) });
    const differing = disagreements(name, packument, rows, origin);
    if (differing.length > 0) return { name, status: "refused", disagreements: differing, missing, mismatched, recovered };
    if (!dryRun) {
      await store.append(name, rows);
      const written = await store.read(name);
      await store.materialize(name, renderStoreLayout(foldPackage(name, written.rows), { origin, revision: revisionOf(written) }));
    }
    return { name, status: "received", versions: Object.keys(packument.versions ?? {}).length, missing, mismatched, recovered };
  }

  const state = foldPackage(name, current.rows);
  const layout = await store.readLayout(name).catch(() => undefined);
  const rows = [];
  const report = { name, status: "unchanged", contradictions: state.contradictions.length };
  if (layout?.versions !== undefined && typeof layout.versions === "object") {
    // A version only the layout holds was published by another writer: receive it, never lose it.
    const unknown = Object.fromEntries(Object.entries(layout.versions).filter(([version]) => !state.versions.has(version)));
    if (Object.keys(unknown).length > 0) {
      const { artifacts, missing, mismatched, recovered } = await adoptArtifacts(store, name, unknown, { dryRun });
      const received = legacyRows(name, { name, versions: unknown, time: layout.time }, { artifactOf: (file) => artifacts.get(file) });
      rows.push(...received.filter((row) => row.a === PUBLICATION || row.a === DEPRECATION));
      Object.assign(report, { versions: Object.keys(unknown), missing, mismatched, recovered });
    }
    // Tags and deprecations the layout changed after this registry wrote it at this very journal state.
    if (layout._rev === revisionOf(current)) {
      const at = typeof layout.time?.modified === "string" ? layout.time.modified : now().toISOString();
      const tags = layout["dist-tags"] ?? {};
      for (const [tag, version] of Object.entries(tags)) if (state.tags.get(tag) !== version) rows.push({ e: packageEntity(name), a: DIST_TAG, v: { tag, version }, t: at });
      for (const tag of state.tags.keys()) if (!Object.hasOwn(tags, tag)) rows.push({ e: packageEntity(name), a: DIST_TAG, v: { tag, version: null }, t: at });
      for (const [version, manifest] of Object.entries(layout.versions)) {
        if (!state.versions.has(version)) continue;
        const message = typeof manifest?.deprecated === "string" && manifest.deprecated !== "" ? manifest.deprecated : null;
        if ((state.deprecations.get(version) ?? null) !== message) rows.push({ e: versionEntity(name, version), a: DEPRECATION, v: message, t: at });
      }
    }
  }
  if (dryRun) return { ...report, ...(rows.length > 0 ? { status: "would-receive", rows: rows.length } : {}) };
  if (rows.length > 0) { await store.append(name, rows); report.status = "received"; report.rows = rows.length; }
  const written = rows.length > 0 ? await store.read(name) : current;
  // Compared as it is written: the file holds JSON, so the projection is compared as JSON too.
  const projection = JSON.parse(JSON.stringify(renderStoreLayout(foldPackage(name, written.rows), { origin, revision: revisionOf(written) })));
  if (!isDeepStrictEqual(layout, projection)) {
    await store.materialize(name, projection);
    if (report.status === "unchanged") report.status = "materialized";
  }
  return report;
}

/** Receive one package under its lock. */
export const receivePackage = (store, name, options) => store.lock(name, () => receiveHeld(store, name, options));

/** Receive every package the store holds that `admits` (a name predicate): a summary, and every package that was not
 *  simply unchanged. One package at a time, each under its own lock, so a serving registry keeps answering. */
export async function receiveStore(store, { admits = () => true, ...options }) {
  const summary = { kind: "registry-reception.v1", storage: store.storage, packages: 0, received: 0, materialized: 0, unchanged: 0, refused: [], incomplete: [], recovered: [] };
  for (const name of await store.names()) {
    if (!admits(name)) continue;
    summary.packages += 1;
    let outcome;
    // A dry run writes nothing, not even a lock file; what it reads may be a write behind, which only a real run settles.
    try { outcome = options.dryRun ? await receiveHeld(store, name, options) : await receivePackage(store, name, options); }
    catch (error) { summary.refused.push({ name, error: error.message }); continue; }
    if (outcome.status === "refused") summary.refused.push(outcome);
    else if (outcome.status === "received" || outcome.status === "would-receive") summary.received += 1;
    else if (outcome.status === "materialized") summary.materialized += 1;
    else if (outcome.status === "unchanged") summary.unchanged += 1;
    if (outcome.recovered?.length) summary.recovered.push({ name, versions: outcome.recovered });
    if (outcome.missing?.length || outcome.mismatched?.length || outcome.contradictions) summary.incomplete.push({ name, missing: outcome.missing ?? [], mismatched: outcome.mismatched ?? [], contradictions: outcome.contradictions ?? 0 });
  }
  return summary;
}
