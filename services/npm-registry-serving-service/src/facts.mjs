/**
 * The registry's underlying data: what has happened to each package, as EAVT witnesses `{e, a, v, t}` (the house
 * EAVT row shape; eavt-services-section reads these lines as they are). Everything the npm protocol answers is a
 * projection of these rows (projection.mjs); nothing it answers is stored for its own sake.
 *
 * - `e` is the package's Package URL (purl): `pkg:npm/%40scope/name` for facts about the package, and
 *   `pkg:npm/%40scope/name@1.0.0` for facts about one version. A purl names the package, not this registry, so the
 *   facts do not change when the registry's origin does.
 * - `a` is one of the attributes below. A reader ignores an attribute it does not know.
 * - `t` is when the fact was recorded (ISO 8601), or null where the store it was received from did not say.
 *
 * Attributes:
 * - `npm.publication` (version): `{manifest, artifact: {file, ni?, size?}}`. The manifest as published, its
 *   `dist` without the tarball URL (the URL is derived from the origin and `file`) and without `deprecated`. `ni` is
 *   the RFC 6920 name of the tarball's bytes in the blob store; a version received without its bytes has none.
 *   A version is published once: a second publication of it is a contradiction the projection keeps out.
 * - `npm.dist-tag` (package): `{tag, version}`; `version: null` removes the tag.
 * - `npm.deprecation` (version): the message, or null to clear it.
 * - `npm.readme` (package): the readme text.
 * - `npm.packument-fields` (package): top-level packument fields this vocabulary does not model, received from an
 *   earlier store, kept so that what it served is still served.
 * - `npm.reception` (package): the rows before it were received from an earlier store, as of `t`.
 */
export const PUBLICATION = "npm.publication";
export const DIST_TAG = "npm.dist-tag";
export const DEPRECATION = "npm.deprecation";
export const README = "npm.readme";
export const PACKUMENT_FIELDS = "npm.packument-fields";
export const RECEPTION = "npm.reception";

/** The purl of a package: `pkg:npm/%40scope/name`, or `pkg:npm/name`. */
export function packageEntity(name) {
  const slash = name.startsWith("@") ? name.indexOf("/") : -1;
  return slash === -1 ? `pkg:npm/${encodeURIComponent(name)}`
    : `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}`;
}

/** The purl of one version of a package. */
export function versionEntity(name, version) {
  return `${packageEntity(name)}@${encodeURIComponent(version)}`;
}

/** The version a row's entity names under `name`'s purl, or undefined when it names the package or another one. */
export function versionOf(name, entity) {
  const prefix = `${packageEntity(name)}@`;
  return typeof entity === "string" && entity.startsWith(prefix) ? decodeURIComponent(entity.slice(prefix.length)) : undefined;
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A row as the journal holds it, or a TypeError naming what is wrong with it. */
export function admittedRow(row) {
  if (!record(row) || Object.keys(row).length !== 4 || typeof row.e !== "string" || typeof row.a !== "string"
    || !Object.hasOwn(row, "v") || !(row.t === null || (typeof row.t === "string" && !Number.isNaN(Date.parse(row.t))))) {
    throw new TypeError("a registry fact is exactly {e, a, v, t}: entity and attribute strings, a value, and an ISO time or null");
  }
  return row;
}

/** The leaf file name of a version's tarball: the one its stored URL names, else npm's canonical `name-version.tgz`. */
export function artifactFile(name, version, dist) {
  if (typeof dist?.tarball === "string") {
    try { return decodeURIComponent(new URL(dist.tarball).pathname.split("/").pop()); } catch { /* not a URL; canonical below */ }
  }
  return `${name.split("/").pop()}-${version}.tgz`;
}

// What a Verdaccio-layout packument held only for its own bookkeeping; none of it is the package's.
const STORE_BOOKKEEPING = new Set(["_attachments", "_distfiles", "_uplinks", "_rev"]);
const MODELED = new Set(["name", "versions", "time", "dist-tags", "readme"]);

/**
 * The facts a packument stored in the earlier layout (`<storage>/<name>/package.json`) records. Each version is a
 * publication at its recorded time; tags, deprecations and the readme held as of the packument's `modified` time;
 * fields this vocabulary does not model are kept as they were. `artifactOf(file)` may supply `{ni, size}` for a
 * version's bytes; without it a publication names only its file.
 */
export function legacyRows(name, packument, { artifactOf = () => undefined } = {}) {
  const time = record(packument.time) ? packument.time : {};
  const asOf = typeof time.modified === "string" ? time.modified : null;
  const pkg = packageEntity(name);
  const rows = [];
  const deprecations = [];
  for (const [version, stored] of Object.entries(record(packument.versions) ? packument.versions : {})) {
    if (!record(stored)) continue;
    const { deprecated, ...manifest } = stored;
    const file = artifactFile(name, version, stored.dist);
    if (record(stored.dist)) {
      const { tarball, ...dist } = stored.dist;
      manifest.dist = dist;
    }
    rows.push({ e: versionEntity(name, version), a: PUBLICATION, v: { manifest, artifact: { file, ...artifactOf(file) } }, t: typeof time[version] === "string" ? time[version] : null });
    if (typeof deprecated === "string" && deprecated !== "") deprecations.push({ e: versionEntity(name, version), a: DEPRECATION, v: deprecated, t: asOf });
  }
  for (const [tag, version] of Object.entries(record(packument["dist-tags"]) ? packument["dist-tags"] : {})) {
    if (typeof version === "string") rows.push({ e: pkg, a: DIST_TAG, v: { tag, version }, t: asOf });
  }
  rows.push(...deprecations);
  if (typeof packument.readme === "string") rows.push({ e: pkg, a: README, v: packument.readme, t: asOf });
  const fields = {};
  for (const [key, value] of Object.entries(packument)) {
    if (MODELED.has(key) || STORE_BOOKKEEPING.has(key) || (key === "_id" && value === name)) continue;
    fields[key] = value;
  }
  // `created` is otherwise the first publication's time; keep a recorded one that differs.
  const published = rows.filter((row) => row.a === PUBLICATION && row.t !== null).map((row) => row.t).sort();
  if (typeof time.created === "string" && time.created !== published[0]) fields.time = { created: time.created };
  if (Object.keys(fields).length > 0) rows.push({ e: pkg, a: PACKUMENT_FIELDS, v: fields, t: asOf });
  if (asOf !== null) rows.push({ e: pkg, a: RECEPTION, v: { layout: "verdaccio-packument" }, t: asOf });
  return rows;
}
