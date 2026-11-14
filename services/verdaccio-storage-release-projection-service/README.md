# Verdaccio storage release projection service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

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

By default only exact stable `x.y.z` releases with scoped sovereign names
are admitted. An operator may explicitly request a retained development
prerelease with `--development-release @scope/package@x.y.z-dev.N` (repeatable)
or the API's `developmentReleases` array. This does not admit other prereleases
or relax scope, identity, integrity or dependency checks. A requested release
that cannot be admitted fails the whole projection; absence is never an empty
success. This does not publish or set registry tags. `@emsenn/*`, unscoped releases, and any manifest retaining
`workspace:`, `file:`, or `link:` dependency protocols are excluded explicitly.
The protocol check reads both the measured archive's embedded manifest and the
registry packument; an exclusion identifies which one supplied the dependency.
For admitted releases the two runtime dependency maps must agree (absent and
empty maps are equivalent). A disagreement is not safe snapshot input.

```sh
project-verdaccio-storage-releases \
  --storage-root /path/to/verdaccio/storage \
  --owned-scope red-cup-engineering > releases.json
```

The JSON result contains `admitted` entries shaped for snapshot assembly:
`{ manifest, artifactPath, integrity, measurement }`. `excluded` is legacy
custody-evidence only; it is not a receipt or a candidate snapshot.
The service contains no registry writes and does not claim dependency closure.

## Acceptance

Run `npm test` for the source suite. See the [runnable consumer example](examples/quickstart.test.mjs).
