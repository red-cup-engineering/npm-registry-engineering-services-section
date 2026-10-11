# Corrupted tarball URLs

## What was broken

Every version of every locally-published package (any scope, published
straight through `npm publish` against this registry — observed with npm
11.17.0 against Verdaccio 6.9.2) had its stored `dist.tarball` metadata
duplicate the package's own name a second time after the `/-/` separator:

```
http://127.0.0.1:4873/@scope/name/-/@scope/name-1.0.0.tgz     (stored, wrong)
http://127.0.0.1:4873/@scope/name/-/name-1.0.0.tgz             (route actually served)
```

The malformed URL 404s; Verdaccio itself, and the tarball attachment it
actually wrote to disk, were never wrong — only the `dist.tarball` string the
npm client embedded in the publish payload was. This reproduces with a plain,
unmodified `npm publish` and no estate tooling involved, so it is a defect in
what that npm client version self-reports for scoped packages against this
registry, not a bug in Verdaccio's storage or in the estate's own code.
Unscoped packages are unaffected (their leaf name equals their full name, so
there is nothing to duplicate). Proxied third-party packages cached from
`registry.npmjs.org` are unaffected (they were never published locally).

## What fixes it

**Future publishes:** `npm-workspace-publication-service` (the sibling
package's own `scripts/publish-workspace-tiers.mjs` and
`scripts/recover-demanded-versions.mjs`) now calls
`repairStorageTarballURL` (in `src/registry.mjs`, using the corruption test
`correctedTarballURL` in `src/tarball-guard.mjs`) immediately after every
`npm publish`, rewriting that version's `dist.tarball` in this registry's
storage if it was corrupted. This is metadata-only and self-healing: it never
touches the `.tgz` bytes, and no operator flag is required — it defaults to
this service's own `data/storage` directory.

**Already-published entries:** `scripts/repair-corrupted-tarball-urls.mjs` in
this package walks every `package.json` under `data/storage/`, scope and
unscoped alike, and rewrites any `dist.tarball` carrying the corrupted shape
back to the correct one. It is metadata-only, idempotent (a second run finds
nothing left to change), and accepts `--dry-run` and repeatable `--exclude
<name>` for packages a concurrent publish workflow is actively writing (a
short-lived default exclusion list lives at the top of the script — remove a
name once that publication has settled, then rerun to pick up any stragglers
under it). Run from this package directory:

```sh
node scripts/repair-corrupted-tarball-urls.mjs --dry-run   # see what would change
node scripts/repair-corrupted-tarball-urls.mjs             # apply
```
