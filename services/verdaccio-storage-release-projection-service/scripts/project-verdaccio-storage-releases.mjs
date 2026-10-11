#!/usr/bin/env node
import { projectVerdaccioStorageReleases } from "../src/project-verdaccio-storage-releases.mjs";

function values(flag) { return process.argv.flatMap((value, index) => value === flag && process.argv[index + 1] ? [process.argv[index + 1]] : []); }
function value(flag) { return values(flag).at(-1); }

const storageRoot = value("--storage-root");
if (!storageRoot) throw new Error("--storage-root is required");
const result = await projectVerdaccioStorageReleases({ storageRoot, ownedScopes: values("--owned-scope"), ownedUnscopedNames: values("--owned-unscoped-name") });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
