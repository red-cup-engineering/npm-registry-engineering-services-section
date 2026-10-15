import { npmPublicationRegistryArguments } from "./npm-publication-target.mjs";
import { assertHousePublicationVersion, publicationTagForVersion } from "./release-wave.mjs";
import { isAbsolute } from "node:path";

export function npmPublicationArguments({ name, version }, publishRegistry, requestedTag, { artifact } = {}) {
  if (typeof name !== "string" || name === "") throw new TypeError("publication entry requires a package name");
  if (artifact !== undefined && (typeof artifact !== "string" || !isAbsolute(artifact) || !artifact.endsWith(".tgz"))) throw new TypeError("publication artifact must be an absolute npm tarball path");
  assertHousePublicationVersion(name, version);
  const tag = publicationTagForVersion(version, requestedTag);
  return Object.freeze([
    "publish", ...(artifact === undefined ? [] : [artifact]), "--ignore-scripts", "--provenance=false", "--tag", tag,
    "--loglevel=error", "--json", ...npmPublicationRegistryArguments(name, publishRegistry),
  ]);
}
