# Verdaccio Services Section

Runs the private npm registry for 561 Group packages. It is deliberately ordinary Verdaccio, not a custom registry implementation.

Each service is an independent npm package. Verdaccio is the only install boundary between them: package manifests use exact semantic versions, never workspace, file, link, Git, tag, or range specifications. The repository root is not a package or a package-manager workspace.

Verdaccio listens at `http://127.0.0.1:4873/`. The local-development profile
in `content/config/config.yaml` proxies public packages to npmjs while keeping
internal scopes private. The Cold Red Gate profile in
`content/config/cold-red-gate.yaml` is a storage-bounded house mirror: it has
no public uplink or fallback and carries the wider set of scopes preserved from
the active VPS deployment.

These are host profiles of one registry service owner, not two competing
registry packages. The historical deployed identity
`@red-cup-engineering/verdaccio-561-group@0.1.0` maps here; registry storage,
the htpasswd file, npm credentials, and mirror-staging tarballs remain machine
data and are not source-controlled.

## Registry custody

The canonical registry is `https://registry.561.group/` (Verdaccio on
Cold Red Gate, `verdaccio-561-group` user unit, public TLS via Caddy).
This laptop's `verdaccio` unit is a read-through cache of it (see the
`canonical` uplink in `content/config/config.yaml`); state lives at
`~/.local/state/verdaccio/`. The org custody guide — consuming,
publishing, channels, the lockfile law — lives in 561-group custody:
`561-group-services-section/.../561-group-javascript-computer-code-engineering-services-section/content/text/documents/articles/teaching-articles/guides/house-npm-registry.md`.

## Client routing on this machine

The repository is a forest of independent packages, not an npm workspace.
Repository-root npm configuration therefore does not apply when commands run
inside a nested package. Registry location is machine state and belongs in
the user's npm configuration instead of being copied into every project.

Configure all estate-owned scopes from this directory:

```sh
npm run configure-client
```

Cold Red Gate selects its wider house-mirror scope list explicitly:

```sh
npm run configure-client:cold-red-gate
```

This idempotently derives the private scope list from
`content/config/config.yaml` and writes only those scope routes to
`~/.npmrc`. Public packages continue to use `https://registry.npmjs.org/`.

The configured package scopes are:

- `@561-group`
- `@causeway-services`
- `@coesite-operations`
- `@emsenn`
- `@lenticule-science`
- `@red-cup-engineering`

`npm run check-client` verifies the routing without writing. Both `npm run
serve` and the installed user service configure it before Verdaccio starts,
so registry configuration and client routing share one source of truth.

Individual projects need an `.npmrc` only when they deliberately override
this machine configuration, such as routing selected scopes to Artifact Registry.
They must not set the unscoped default registry to localhost.

**Broken install?** A stale lockfile resolving against a dead registry (a
GCP mirror, an old host, a corrupted URL) is a known disease. Fix:

```sh
rm -rf node_modules package-lock.json && npm install
```

Then confirm every `resolved` URL in the new lock points at
`https://registry.561.group` — a stale `node_modules` alone can mask an
unresolved lockfile, so remove both, never the lockfile only.

## Run locally

From this service directory, install and start the registry independently:

```sh
npm ci --registry http://127.0.0.1:4873/
npm run serve
```

In another shell:

```sh
npm run ping
```

Verdaccio stores registry data and the htpasswd file beneath this package's ignored `data/` directory.

The repository-owned Cold Red Gate unit template is
`content/deployment/systemd-user/cold-red-gate/verdaccio-561-group.service`.
It selects the host profile and hardens the htpasswd file before startup. Its
presence does not prove that the live unit or deployed package has been updated;
that requires a separate deployment and post-restart assay.

Publish with the normal package-manager command — `~/.npmrc` routes house
scopes to the canonical registry, so no explicit `--registry` is needed:

```sh
npm publish
```

Internal scopes are never proxied to the public npm registry. This avoids dependency-confusion fallback when a private package has not been published yet.

## Publish gate

Before any publish: extract the currently-published tarball from this
registry's storage, diff it against source, and run the package's tests
against a fresh install. Publish only additive/compatible changes with
green tests — a breaking diff means re-pin consumers or stop and record,
never publish a major on momentum. Every publish and refusal goes in a
dated receipt.

## Corrupted tarball URLs

Published packages can end up with a `dist.tarball` metadata URL that 404s even though the tarball is present and Verdaccio is healthy. See `content/config/corrupted-tarball-urls.md` for what causes this and `scripts/repair-corrupted-tarball-urls.mjs` for the idempotent repair.
