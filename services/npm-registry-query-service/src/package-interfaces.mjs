import { posix } from "node:path";

function immutableJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson));
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableJson(item)])));
  }
  return value;
}

function sortedStringEntries(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(Object.entries(value)
    .filter(([name, item]) => name !== "" && typeof item === "string")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => Object.freeze({ name, value: item })));
}

function stringList(value) {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return Object.freeze([...new Set(items.filter((item) => typeof item === "string" && item !== ""))].sort());
}

function normalizedBinTarget(value) {
  if (typeof value !== "string") return null;
  const target = posix.join("/", value.replace(/[\\:]/gu, "/")).slice(1);
  return target === "" ? null : target;
}

function normalizedBinName(value) {
  if (typeof value !== "string") return null;
  const name = posix.basename(value.replace(/[\\:]/gu, "/"));
  return name === "" ? null : name;
}

/** Normalize every package.json#bin form accepted by current npm into a stable list. */
export function packageBinaries(manifest) {
  let declarations;
  if (typeof manifest?.bin === "string") declarations = [[manifest.name, manifest.bin]];
  else if (Array.isArray(manifest?.bin)) declarations = manifest.bin.map((target) => [typeof target === "string" ? posix.basename(target.replaceAll("\\", "/")) : null, target]);
  else if (manifest?.bin !== null && typeof manifest?.bin === "object") declarations = Object.entries(manifest.bin);
  else declarations = [];

  const normalized = new Map();
  for (const [declaredName, declaredTarget] of declarations) {
    const name = normalizedBinName(declaredName);
    const target = normalizedBinTarget(declaredTarget);
    if (name !== null && target !== null) normalized.set(name, target);
  }
  return Object.freeze([...normalized.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, target]) => Object.freeze({ name, target })));
}

/** Read standard package.json interface declarations without semantic inference. */
export function readPackageInterfaces(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new TypeError("manifest must be an object");
  const scripts = sortedStringEntries(manifest.scripts)
    .map(({ name, value: command }) => Object.freeze({ name, command }));
  const engines = sortedStringEntries(manifest.engines)
    .map(({ name, value: range }) => Object.freeze({ name, range }));
  return Object.freeze({
    entrypoints: Object.freeze({
      exports: immutableJson(manifest.exports ?? null),
      imports: immutableJson(manifest.imports ?? null),
      main: typeof manifest.main === "string" ? manifest.main : null,
      module: typeof manifest.module === "string" ? manifest.module : null,
      types: typeof manifest.types === "string" ? manifest.types : typeof manifest.typings === "string" ? manifest.typings : null,
    }),
    binaries: packageBinaries(manifest),
    scripts: Object.freeze(scripts),
    constraints: Object.freeze({
      engines: Object.freeze(engines),
      os: stringList(manifest.os),
      cpu: stringList(manifest.cpu),
    }),
  });
}
