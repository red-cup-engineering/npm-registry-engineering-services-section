import semver from "semver";
import { DEPRECATION, DIST_TAG, PACKUMENT_FIELDS, PUBLICATION, README, packageEntity, versionOf } from "./facts.mjs";

/**
 * The npm documents a package's facts (facts.mjs) project to. Pure: rows in, documents out, nothing read or written.
 *
 * `foldPackage` reads the rows in order into the package's state; the render functions present that state as npm's
 * registry protocol shapes it (https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md): the
 * full packument, the abbreviated install document, one version's manifest, and the packument as the earlier
 * Verdaccio-layout store held it on disk.
 */

const time = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN);

/** A package's state after its rows, in order. A version's first publication is its publication; any later one is a
 *  contradiction, kept in `contradictions` and out of every document. */
export function foldPackage(name, rows) {
  const pkg = packageEntity(name);
  const state = {
    name, versions: new Map(), tags: new Map(), deprecations: new Map(), readme: undefined, fields: {},
    created: undefined, modified: undefined, count: rows.length, contradictions: [],
  };
  for (const row of rows) {
    if (!Number.isNaN(time(row.t)) && (state.modified === undefined || time(row.t) > time(state.modified))) state.modified = row.t;
    if (row.e === pkg) {
      if (row.a === DIST_TAG && typeof row.v?.tag === "string") {
        if (typeof row.v.version === "string") state.tags.set(row.v.tag, row.v.version);
        else state.tags.delete(row.v.tag);
      } else if (row.a === README && typeof row.v === "string") state.readme = row.v;
      else if (row.a === PACKUMENT_FIELDS && row.v !== null && typeof row.v === "object") Object.assign(state.fields, row.v);
      continue;
    }
    const version = versionOf(name, row.e);
    if (version === undefined) continue;
    if (row.a === PUBLICATION) {
      if (state.versions.has(version)) { state.contradictions.push(row); continue; }
      state.versions.set(version, { manifest: row.v.manifest, artifact: row.v.artifact, t: row.t });
      if (!Number.isNaN(time(row.t)) && (state.created === undefined || time(row.t) < time(state.created))) state.created = row.t;
    } else if (row.a === DEPRECATION) {
      if (typeof row.v === "string" && row.v !== "") state.deprecations.set(version, row.v);
      else state.deprecations.delete(version);
    }
  }
  if (typeof state.fields.time?.created === "string") state.created = state.fields.time.created;
  return state;
}

/** The version `selector` names: a published version, or a dist-tag of one. */
export function selectVersion(state, selector) {
  if (state.versions.has(selector)) return selector;
  const tagged = state.tags.get(selector);
  return tagged !== undefined && state.versions.has(tagged) ? tagged : undefined;
}

/** The version an install without one gets: `latest`, else the highest published release. */
export function latestVersion(state) {
  const tagged = selectVersion(state, "latest");
  if (tagged !== undefined) return tagged;
  const valid = [...state.versions.keys()].filter((version) => semver.valid(version) !== null);
  return valid.length > 0 ? semver.rsort(valid)[0] : [...state.versions.keys()].at(-1);
}

/** The tarball URL a version is served at. */
export const tarballUrl = (state, file, origin) => `${origin}/${state.name}/-/${file}`;

/** One version's manifest as npm serves it: as published, with its deprecation and its tarball on this origin. */
export function renderVersion(state, version, { origin }) {
  const entry = state.versions.get(version);
  if (entry === undefined) return undefined;
  const deprecated = state.deprecations.get(version);
  return {
    ...entry.manifest,
    ...(deprecated === undefined ? {} : { deprecated }),
    dist: { ...entry.manifest.dist, tarball: tarballUrl(state, entry.artifact.file, origin) },
  };
}

/** The package's dist-tags, each naming a published version. */
export function distTags(state) {
  const tags = {};
  for (const [tag, version] of state.tags) if (state.versions.has(version)) tags[tag] = version;
  return tags;
}

/** Who published the package's versions, as npm's `maintainers` lists them. */
function publishersOf(state) {
  const names = [...state.versions.values()].map((entry) => entry.manifest?._npmUser?.name).filter((user) => typeof user === "string");
  return [...new Set(names)].sort();
}

// npm's registry presents these top-level fields from the latest version; clients (npm repo/docs, update bots)
// read them there.
const LATEST_FIELDS = ["description", "keywords", "license", "homepage", "repository", "bugs", "author"];

/** The full packument. `revision` is the document's `_rev`. */
export function renderFull(state, { origin, revision }) {
  const versions = {};
  for (const version of state.versions.keys()) versions[version] = renderVersion(state, version, { origin });
  const times = {};
  if (state.created !== undefined) times.created = state.created;
  if (state.modified !== undefined) times.modified = state.modified;
  for (const [version, entry] of state.versions) if (typeof entry.t === "string") times[version] = entry.t;
  const latest = latestVersion(state);
  const top = {};
  if (latest !== undefined) for (const field of LATEST_FIELDS) if (Object.hasOwn(versions[latest], field)) top[field] = versions[latest][field];
  const publishers = publishersOf(state);
  const { time: _receivedTime, ...fields } = state.fields;
  return {
    _id: state.name,
    ...(revision === undefined ? {} : { _rev: revision }),
    name: state.name,
    ...top,
    ...(publishers.length > 0 ? { maintainers: publishers.map((user) => ({ name: user })) } : {}),
    ...fields,
    "dist-tags": distTags(state),
    versions,
    ...(Object.keys(times).length > 0 ? { time: times } : {}),
    ...(state.readme === undefined ? {} : { readme: state.readme }),
  };
}

export const INSTALL_FIELDS = Object.freeze([
  "name", "version", "deprecated", "dependencies", "acceptDependencies", "optionalDependencies",
  "devDependencies", "bundleDependencies", "bundledDependencies", "peerDependencies", "peerDependenciesMeta",
  "bin", "directories", "dist", "engines", "_hasShrinkwrap", "funding", "cpu", "os", "libc",
]);

/** A full manifest's abbreviated install form: the fields an install reads, and whether it runs an install script. */
export function installManifest(manifest) {
  const selected = Object.fromEntries(INSTALL_FIELDS.filter((field) => Object.hasOwn(manifest, field)).map((field) => [field, manifest[field]]));
  selected.hasInstallScript = manifest.hasInstallScript === true || manifest.gypfile === true
    || ["preinstall", "install", "postinstall"].some((script) => Boolean(manifest.scripts?.[script]));
  return selected;
}

/** The abbreviated install document (`application/vnd.npm.install-v1+json`). */
export function renderAbbreviated(state, { origin }) {
  const versions = {};
  for (const version of state.versions.keys()) versions[version] = installManifest(renderVersion(state, version, { origin }));
  return { name: state.name, ...(state.modified === undefined ? {} : { modified: state.modified }), "dist-tags": distTags(state), versions };
}

/** The packument as the earlier Verdaccio-layout store held it at `<storage>/<name>/package.json`: the full document
 *  with that store's bookkeeping, so a store read by an earlier registry release still serves every fact. */
export function renderStoreLayout(state, { origin, revision }) {
  const attachments = {};
  for (const { manifest, artifact } of state.versions.values()) attachments[artifact.file] = { shasum: manifest.dist?.shasum };
  return { ...renderFull(state, { origin, revision }), _attachments: attachments, _distfiles: {}, _uplinks: {} };
}

/** The package as `GET /-/v1/search` lists it. */
export function searchEntry(state, { origin, repository }) {
  const version = latestVersion(state);
  const manifest = version === undefined ? undefined : renderVersion(state, version, { origin });
  if (manifest === undefined) return undefined;
  const source = repository(manifest.repository);
  return {
    name: state.name, version, description: manifest.description ?? "",
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
    date: state.versions.get(version).t ?? state.modified ?? null,
    links: { npm: `${origin}/${state.name}`, ...(source ? { repository: `https://github.com/${source}` } : {}) },
    publisher: manifest._npmUser ?? undefined,
    maintainers: publishersOf(state).map((user) => ({ name: user })),
  };
}
