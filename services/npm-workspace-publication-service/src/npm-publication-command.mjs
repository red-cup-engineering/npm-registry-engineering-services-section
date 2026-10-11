import { npmPublicationRegistryArguments } from "./npm-publication-target.mjs";
import { assertHousePublicationVersion, publicationTagForVersion } from "./release-wave.mjs";

export function npmPublicationArguments({ name, version }, publishRegistry, requestedTag) {
  if (typeof name !== "string" || name === "") throw new TypeError("publication entry requires a package name");
  assertHousePublicationVersion(name, version);
  const tag = publicationTagForVersion(version, requestedTag);
  return Object.freeze([
    "publish", "--ignore-scripts", "--provenance=false", "--tag", tag,
    "--loglevel=error", "--json", ...npmPublicationRegistryArguments(name, publishRegistry),
  ]);
}
