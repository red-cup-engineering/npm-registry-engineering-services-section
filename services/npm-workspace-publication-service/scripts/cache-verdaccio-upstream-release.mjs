#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { cacheVerdaccioLockfile, cacheVerdaccioUpstreamRelease } from "../src/verdaccio-upstream-cache.mjs";
const args = process.argv.slice(2);
if (args.includes("--help")) {
 console.log("cache-verdaccio-upstream-release --storage DIR (--package NAME --version X.Y.Z [--integrity SHA512] | --lock PACKAGE_LOCK) [--upstream HTTPS_URL] [--backup DIR --apply]\nStop the registry before --apply and restart afterward. Exact archives are verified; existing releases and tags are preserved.");
} else {
 const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
 const operation = value("--lock") ? (input) => cacheVerdaccioLockfile({...input, packageLock: JSON.parse(lockText)}) : cacheVerdaccioUpstreamRelease;
 const lockText = value("--lock") ? await readFile(value("--lock"), "utf8") : null;
 console.log(JSON.stringify(await operation({storage:value("--storage"),packageName:value("--package"),version:value("--version"),upstream:value("--upstream"),backupDirectory:value("--backup"),expectedIntegrity:value("--integrity"),apply:args.includes("--apply")})));
}
