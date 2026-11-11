#!/usr/bin/env node
import { repairScopedPublicationArtifact } from "../src/repair-scoped-publication-artifact.mjs";
const [storage, name, version, ...extra] = process.argv.slice(2);
if (extra.length) throw new TypeError("usage: repair-scoped-publication-artifact STORAGE NAME VERSION");
console.log(JSON.stringify(await repairScopedPublicationArtifact({ storage, name, version })));
