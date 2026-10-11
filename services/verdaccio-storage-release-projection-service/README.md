# Verdaccio storage release projection service

This is a one-way, read-only boundary from legacy Verdaccio storage to the
explicit release input accepted by npm registry snapshot assembly. It is not a
publisher, an assembler, a registry reader, or a source-package discoverer.

The caller names the storage root and the scopes it owns. Every indexed release
is measured as custody evidence. An owned release is admitted only with exact
measured artifact bytes; every other release is retained as a typed exclusion
with its manifest, artifact path, and measurement. Missing metadata or
attachments, digest disagreement, or a disagreement between the tarball's
`package/package.json` and the packument is a hard refusal: such a release has
no trustworthy carrier to project.

Only exact `x.y.z`, scoped sovereign names accepted by snapshot assembly are
admitted. `@emsenn/*`, unscoped releases, and any manifest retaining
`workspace:`, `file:`, or `link:` dependency protocols are excluded explicitly.

```sh
project-verdaccio-storage-releases \
  --storage-root /path/to/verdaccio/storage \
  --owned-scope red-cup-engineering > releases.json
```

The JSON result contains `admitted` entries shaped for snapshot assembly:
`{ manifest, artifactPath, measurement }`. `excluded` is legacy
custody-evidence only; it is not a receipt or a candidate snapshot.
The service contains no registry writes and does not claim dependency closure.
