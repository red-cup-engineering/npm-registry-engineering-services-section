# npm registry read service

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
