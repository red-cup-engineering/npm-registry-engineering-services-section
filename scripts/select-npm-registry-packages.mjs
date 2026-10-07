#!/usr/bin/env node
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { freezeJson } from "@red-cup-engineering/json-services-section";
import { parseLines, serializeLines } from "@red-cup-engineering/jsonl-services-section";
import { parseJavascriptArgv } from "@red-cup-engineering/javascript-node-services-section/argv";
import { readJavascriptFileExportDocumentation } from "@red-cup-engineering/read-javascript-file-export-documentation-service";

const EXACT_RELEASE = /^(?:(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)|([a-z0-9][a-z0-9._-]*))@(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?)$/iu;

/**
 * Selects exact package releases from one npm registry package reading without consulting the registry again.
 *
 * @param {object} request An NpmRegistryPackageSelectionRequest@1 carrying package rows and name or exact-release selectors.
 * @returns {object} An immutable NpmRegistryPackageSelection@1 preserving selected package rows in selector order.
 * @throws {Error} When a selector is absent or version-ambiguous.
 */
export function selectNpmRegistryPackages(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) throw new TypeError("input must be an NpmRegistryPackageSelectionRequest");
  if (Object.keys(request).sort().join(",") !== "packages,selections,type,version") throw new TypeError("request must carry exactly packages, selections, type, and version");
  if (request.type !== "NpmRegistryPackageSelectionRequest" || request.version !== 1) throw new TypeError("request type and version must be NpmRegistryPackageSelectionRequest@1");
  if (!Array.isArray(request.packages) || !Array.isArray(request.selections) || !request.selections.every((selection) => typeof selection === "string" && selection.length > 0)) throw new TypeError("packages and string selections must be arrays");
  for (const row of request.packages) if (row === null || typeof row !== "object" || Array.isArray(row) || typeof row.name !== "string" || typeof row.version !== "string" || !`${row.name}@${row.version}`.match(EXACT_RELEASE)) throw new TypeError("each package row must carry an exact npm name and version");

  const selected = [];
  const selections = [...new Set(request.selections)];
  if (selections.length === 0) selected.push(...request.packages);
  for (const selection of selections) {
    const exact = selection.match(EXACT_RELEASE);
    const matches = exact
      ? request.packages.filter(({ name, version }) => name === (exact[1] ?? exact[2]) && version === exact[3])
      : request.packages.filter(({ name }) => name === selection);
    if (matches.length === 0) throw new Error(`package selection is absent: ${selection}`);
    if (matches.length > 1) throw new Error(`package selection is version-ambiguous: ${selection}`);
    selected.push(matches[0]);
  }
  return freezeJson({ type: "NpmRegistryPackageSelection", version: 1, selections, packages: selected });
}

if (import.meta.main) {
  const parsed = parseJavascriptArgv({ type: "JavascriptArgvParsingRequest", version: 1, argumentVector: { type: "JavascriptArgumentVector", version: 1, arguments: process.argv }, options: { help: { type: "boolean", short: "h", default: false } }, allowPositionals: false, strict: true });
  if (parsed.options.help) {
    const source = await readFile(new URL(import.meta.url), "utf8");
    const [documentation] = readJavascriptFileExportDocumentation({ type: "TextFileRead", path: "scripts/select-npm-registry-packages.mjs", text: source });
    const helpOutput = `${documentation.name} — ${documentation.description}\n\n${documentation.signature}\n`;
    if (!process.stdout.write(helpOutput)) await once(process.stdout, "drain");
  } else {
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const output = serializeLines(parseLines(text).map(selectNpmRegistryPackages));
    if (!process.stdout.write(output)) await once(process.stdout, "drain");
  }
}
