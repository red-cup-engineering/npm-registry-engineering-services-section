#!/usr/bin/env node
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { freezeJson } from "@red-cup-engineering/json-engine/freeze-json";
import { parseArgs } from "node:util";

const EXACT_RELEASE = /^(?:(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)|([a-z0-9][a-z0-9._-]*))@(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?)$/iu;

/**
 * Selects exact package releases from one npm registry package reading without consulting the registry again.
 *
 * @param {object} request An NpmRegistryPackageSelectionRequest@1 carrying package rows and name or exact-release selectors.
 * @returns {object} An immutable NpmRegistryPackageSelection@1 preserving first selection order, with one row per exact release.
 * @throws {Error} When a selector is absent or version-ambiguous, or the receipt repeats a release coordinate.
 */
export function selectNpmRegistryPackages(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) throw new TypeError("input must be an NpmRegistryPackageSelectionRequest");
  if (Object.keys(request).sort().join(",") !== "packages,selections,type,version") throw new TypeError("request must carry exactly packages, selections, type, and version");
  if (request.type !== "NpmRegistryPackageSelectionRequest" || request.version !== 1) throw new TypeError("request type and version must be NpmRegistryPackageSelectionRequest@1");
  if (!Array.isArray(request.packages) || !Array.isArray(request.selections) || !request.selections.every((selection) => typeof selection === "string" && selection.length > 0)) throw new TypeError("packages and string selections must be arrays");
  const byCoordinate = new Map();
  const byName = new Map();
  for (const row of request.packages) {
    if (row === null || typeof row !== "object" || Array.isArray(row) ||
        typeof row.name !== "string" || typeof row.version !== "string")
      throw new TypeError("each package row must carry an exact npm name and version");
    const coordinate = `${row.name}@${row.version}`;
    const match = coordinate.match(EXACT_RELEASE);
    if (!match || (match[1] ?? match[2]) !== row.name || match[3] !== row.version)
      throw new TypeError("each package row must carry an exact npm name and version");
    if (byCoordinate.has(coordinate)) throw new Error(`duplicate release coordinate: ${coordinate}`);
    byCoordinate.set(coordinate, row);
    const named = byName.get(row.name) ?? [];
    named.push(row);
    byName.set(row.name, named);
  }

  const selections = [...new Set(request.selections)];
  const distinct = new Set();
  const selected = [];
  if (selections.length === 0) {
    for (const row of byCoordinate.values()) selected.push(row);
  }
  for (const selection of selections) {
    const exact = selection.match(EXACT_RELEASE);
    const matches = exact ? [byCoordinate.get(selection)].filter(Boolean) : byName.get(selection) ?? [];
    if (matches.length === 0) throw new Error(`package selection is absent: ${selection}`);
    if (matches.length > 1) throw new Error(`package selection is version-ambiguous: ${selection}`);
    const row = matches[0];
    if (!distinct.has(row)) {
      distinct.add(row);
      selected.push(row);
    }
  }
  return freezeJson({ type: "NpmRegistryPackageSelection", version: 1, selections, packages: selected });
}

if (import.meta.main) {
  const parsed = parseArgs({ args: process.argv.slice(2), options: { help: { type: "boolean", short: "h", default: false } }, allowPositionals: false, strict: true });
  if (parsed.values.help) {
    const {readJavascriptFileExportDocumentation} = await import("@red-cup-engineering/read-javascript-file-export-documentation-service");
    const source = await readFile(new URL(import.meta.url), "utf8");
    const [documentation] = readJavascriptFileExportDocumentation({ type: "TextFileRead", path: "scripts/select-npm-registry-packages.mjs", text: source });
    const helpOutput = `${documentation.name} — ${documentation.description}\n\n${documentation.signature}\n`;
    if (!process.stdout.write(helpOutput)) await once(process.stdout, "drain");
  } else {
    const {parseLines, serializeLines} = await import("@red-cup-engineering/jsonl-engineering-services-section");
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const output = serializeLines(parseLines(text).map(selectNpmRegistryPackages));
    if (!process.stdout.write(output)) await once(process.stdout, "drain");
  }
}
