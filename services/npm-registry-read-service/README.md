# npm registry read service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

This package is the read-only HTTP face for a verified, immutable npm registry
snapshot. It accepts only `GET` and `HEAD`; it never accepts credentials or
performs publication. The mutable operation is outside this process:
snapshot publication verifies a candidate, then atomically replaces
`HOST/current`.

Run the exact released artifact with the lexical `current` pathname:

```sh
serve-npm-registry-read --registry /srv/red-cup/npm-registry/host/current --host 127.0.0.1 --port 4873
```

`current` intentionally remains lexical. Do not substitute `fs.realpath` or a
snapshot directory at process start: after an atomic symlink replacement, the
same long-lived server opens subsequent files beneath the new snapshot. A
request already streaming a tarball holds one file descriptor and therefore
finishes from one complete immutable artifact, not a mixture.

`deploy/npm-registry-read.service` is a tracked deployment record, not an
installed unit. It pins the Node runtime artifact and the released package
artifact path; installation and service management remain host operations.

## Quickstart

A read-only npm snapshot serves GET and HEAD and preserves the artifact path when rewriting public URLs. See the [runnable example](examples/quickstart.test.mjs)
and [public API](docs/API.md).

Run `npm ci`, then `npm test` and `npm run test:consumer`.

Packuments expose conventional `NAME/-/LEAF-VERSION.tgz` URLs. The read service
resolves these against complete name/version entries in snapshot metadata, so
scopes, hyphenated names and prerelease identities are not inferred from suffixes.
Snapshot storage paths and artifact bytes remain unchanged.
