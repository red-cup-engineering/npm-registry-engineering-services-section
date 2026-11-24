"""Form the WSL registry runtime from the host's pinned source record."""

from argparse import ArgumentParser
from base64 import b64encode
from hashlib import sha256, sha512
from io import BytesIO
from pathlib import Path
from subprocess import check_output
from tarfile import open as tar_open
from tempfile import TemporaryDirectory
from urllib.request import urlopen
import json


PLAN_CLOSURE = """
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [tree, registry, planner] = process.argv.slice(1);
const { readLiveTree, moduleClosure, exportedFile } = await import(pathToFileURL(planner));
const packages = readLiveTree(tree);
const manifest = JSON.parse(readFileSync(join(registry, "package.json"), "utf8"));
packages.set(manifest.name, { dir: registry, manifest });
const programs = ["serve", "admit-publisher", "receive-from-peers", "receive-store"];
const closure = moduleClosure(packages, programs.map(program => join(registry, "bin", program + ".mjs")));
if (closure.unresolved.length) throw new Error(closure.unresolved.join("\\n"));
const imports = {};
for (const [name, selection] of closure.packages) {
  for (const subpath of selection.subpaths) {
    const specifier = subpath === "." ? name : name + "/" + subpath;
    imports[specifier] = exportedFile(packages.get(name), subpath === "." ? "" : subpath);
  }
}
console.log(JSON.stringify({ imports, files: closure.files, thirdParty: Object.fromEntries(closure.thirdParty) }));
"""

PRELOAD = """import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const { imports } = JSON.parse(readFileSync(new URL("./runtime.json", import.meta.url), "utf8"));
registerHooks({
  resolve(specifier, context, next) {
    if (!Object.hasOwn(imports, specifier)) return next(specifier, context);
    const target = imports[specifier];
    const url = isAbsolute(target) ? pathToFileURL(target) : new URL(target, import.meta.url);
    return { url: url.href, shortCircuit: true };
  },
});
"""


def receive_dependency(build, name, expected):
    with urlopen(expected["url"], timeout=10) as response:
        archive = response.read(expected["size"] + 1)
    integrity = "sha512-" + b64encode(sha512(archive).digest()).decode()
    checksum = sha256(archive).hexdigest()
    if (len(archive), integrity, checksum) != (expected["size"], expected["integrity"], expected["sha256"]):
        raise ValueError(f"{name} archive differs from the runtime record")
    destination = build / "external" / name
    with tar_open(fileobj=BytesIO(archive), mode="r:gz") as source:
        source.extractall(destination, filter="data")
    package = destination / "package"
    manifest = json.loads((package / "package.json").read_bytes())
    if (manifest["name"], manifest["version"]) != (name, expected["version"]):
        raise ValueError(f"{name} manifest differs from the runtime record")
    module = package / manifest.get("main", "index.js")
    if not module.is_file():
        raise ValueError(f"{name} runtime entry is missing")
    return {"version": manifest["version"], "module": str(module.relative_to(build)),
            "sha256": checksum, "integrity": integrity}


def selected_repository(tree, source):
    repo = tree / source["checkout"]
    root = check_output(["git", "-C", repo, "rev-parse", "--show-toplevel"], text=True).strip()
    if Path(root) != repo:
        raise ValueError(f"{repo} is not the recorded repository's checkout root")
    origin = check_output(["git", "-C", repo, "remote", "get-url", "origin"], text=True).strip()
    if origin != source["repository"]:
        raise ValueError(f"{repo} origin differs from the runtime record")
    return repo


def form_runtime(record, tree, parent):
    source = record["registry"]
    repo = selected_repository(tree, source)
    lagoon = record["lagoon"]
    lagoon_repo = selected_repository(tree, lagoon)
    planner = check_output(["git", "-C", lagoon_repo, "show", f'{lagoon["revision"]}:{lagoon["path"]}'])
    if sha256(planner).hexdigest() != lagoon["sha256"]:
        raise ValueError("Lagoon closure planner differs from the runtime record")
    target = parent / ("source-" + source["revision"][:12])
    if target.exists() or target.is_symlink():
        raise FileExistsError(target)
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    project = Path(source["project"])
    with TemporaryDirectory(prefix=".source-runtime-", dir=parent) as directory:
        scratch = Path(directory)
        build = scratch / "build"
        build.mkdir(mode=0o700)
        planner_file = scratch / "live-runtime.mjs"
        planner_file.write_bytes(planner)
        selected = check_output(["git", "-C", repo, "archive", source["revision"],
                                 *[str(project / path) for path in
                                   ("src", "bin", "data/records/registry-identity-conservation-records", "package.json")]])
        with tar_open(fileobj=BytesIO(selected), mode="r:") as archive:
            archive.extractall(build, filter="data")

        closure = json.loads(check_output(["node", "--input-type=module", "-e", PLAN_CLOSURE,
                                          tree, build / project, planner_file]))
        versions = {name: package["version"] for name, package in record["dependencies"].items()}
        if closure["thirdParty"] != versions:
            raise ValueError("third-party closure differs from the runtime record")
        house_files = [Path(path) for path in closure["files"] if not Path(path).is_relative_to(build)]
        house_modules = {str(path.relative_to(tree)): sha256(path.read_bytes()).hexdigest() for path in house_files}
        if house_modules != record["houseModules"]:
            raise ValueError("house module closure differs from the runtime record")
        deps = {name: receive_dependency(build, name, package) for name, package in record["dependencies"].items()}
        imports = {name: str(Path(path).relative_to(build)) if Path(path).is_relative_to(build) else path
                   for name, path in closure["imports"].items()}
        imports.update({name: dependency["module"] for name, dependency in deps.items()})
        runtime = {"registryRevision": source["revision"], "dependencies": deps, "imports": imports}
        (build / "runtime.json").write_text(json.dumps(runtime, indent=2) + "\n", encoding="utf-8")
        (build / "resolve.mjs").write_text(PRELOAD, encoding="utf-8")
        build.rename(target)
    return target


if __name__ == "__main__":
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("record", type=Path, help="Computer Operations runtime-source.json")
    parser.add_argument("--tree", type=Path, required=True, help="path to the services checkout tree")
    parser.add_argument("--into", type=Path, required=True, help="parent directory for the formed runtime")
    arguments = parser.parse_args()
    with arguments.record.open(encoding="utf-8") as file:
        print(form_runtime(json.load(file), arguments.tree.resolve(), arguments.into.resolve()))
