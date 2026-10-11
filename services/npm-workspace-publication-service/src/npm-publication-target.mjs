export function npmPublicationRegistryArguments(packageName, registry) {
  if (typeof packageName !== "string" || packageName.length === 0) throw new TypeError("publication package name is required");
  const authority = new URL(registry).href;
  const scoped = /^(@[^/]+)\/[^/]+$/u.exec(packageName);
  if (packageName.startsWith("@") && scoped === null) throw new TypeError("scoped publication package name is invalid");
  return Object.freeze([`--registry=${authority}`, ...(scoped === null ? [] : [`--${scoped[1]}:registry=${authority}`])]);
}
