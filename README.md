# npm registry services

This section is decomposing the bespoke registry into small **capability
packages** and private **runtime compositions**. A capability has one bounded
job, a release class, and (when releasable) is consumed through its exact
published version. A runtime composition owns deployment-specific sequencing
and side effects; it is not a substitute for a capability package simply
because it lives beside one in the workspace. This distinction keeps a clean
release artifact—not a checkout or a workspace link—as the unit future agents
test and depend on.

## Extracted capabilities

| Package | Present responsibility | Release status |
| --- | --- | --- |
| `npm-package-tree-discovery-service` | Walks package trees, admits explicitly declared release candidates, and reports deliberate skips/collisions. | Releasable CLI |
| `npm-registry-graph-services-section` | Derives dependency, history, and witness graphs from registry receipts and renders dependency/history DOT. | Releasable CLI |
| `npm-registry-read-service` | Serves the built registry's read-only npm face: health checks, packuments, tarballs, and receipt files; `serve-npm-registry-read` deploys that face as a standalone process. | Releasable library and CLI |
| `npm-registry-receipt-recovery-service` | Rebuilds and validates a registry receipt from served metadata and tarballs. | Releasable library |
| `npm-artifact-integrity-service` | Measures package-artifact bytes and npm SHA-1/SHA-512 digests, then verifies declared measurements. | Releasable library |
| `npm-cache-release-recovery-service` | Audits package-lock evidence and recovers only integrity-matching exact release tarballs from npm's local content cache. | Releasable library |
| `npm-registry-snapshot-verification-service` | Admits complete immutable snapshots by checking receipt, packument, tarball, path, URL, and integrity closure. | Releasable library |
| `npm-registry-snapshot-assembly-service` | Assembles supplied release artifacts and an optional base snapshot into metadata, receipt, npmrc, paths, and deterministic dist-tags, then admits the snapshot. | Releasable library |
| `npm-registry-snapshot-activation-service` | Atomically switches host-local `current` and `last-good` pointers among already verified immutable snapshots. | Releasable library |
| `select-npm-registry-packages-service` | Purely selects exact, unambiguous package releases from supplied registry package rows. | Releasable operation package |
| `check-npm-registry-package-installations-service` | Installs selected exact receipt entries into clean temporary projects and composes installed-package inspection over each result. | Releasable operation package |
| `npm-registry-query-service` | Answers existence, name search, direct dependencies/dependents, and standard package interfaces (`exports`, `imports`, main/module/types entrypoints, normalized bins, scripts, and platform constraints) against a built registry or its HTTP face. | Releasable CLI |
| `npm-workspace-publication-service` | Orders workspace packages into leaf-first dependency tiers and publishes pending versions with pnpm (workspace pins become exact versions at pack time, lifecycle scripts disabled), verifying each packument; dry-run by default, cycles reported rather than thrown. | Releasable CLI |
| `npm-registry-user-service` | Manages the registry's htpasswd users directly ({SHA} scheme, dependency-free): list, add with typed refusals, remove; passwords only from the environment. | Releasable CLI |
| `npm-registry-a2a-projection-service` | Produces/executes A2A registry-snapshot messages; deliberately starts no server. A contracted-agent runtime supplies that transport. | Private projection capability |
| `npm-release-manifest-projection-service` | Projects manifests into publishable form, removing house metadata and replacing local dependency protocols only through exact coordinated-release bindings. | Releasable library, extraction/wiring in progress |
| `npm-carrier-projection-service` | Projects a controlled package carrier, excluding repository and instance territories plus nested packages; can substitute the already-projected release manifest and refuses symbolic links. | Releasable library |
| `npm-registry-release-coordinator-service` | Schedules bounded source preparation under an injected compute lease and delegates discovery, release-binding validation, manifest/carrier projection, packing, assembly, verification, and optional activation to injected exact capabilities. | Releasable library |
| `npm-registry-snapshot-publication-service` | Composes the coordinator and snapshot-activation service to build `host/snapshots/name` and atomically advance `host/current`; it never restarts a server or swaps a live directory. | Releasable CLI |

`npm-registry-service` is now a deprecated private compatibility facade. Its
local-publication command delegates only to the snapshot-publication app; its
old programmatic builder reports the migration requirement rather than hiding
an unsafe deployment handoff. The query and A2A
packages are consumers/projections, not hidden responsibilities of that facade.

## What is still in the composition

The remaining runtime wiring is deliberately thin. The coordinator may only
schedule bounded work, hold/release its injected lease, clean staging space,
and sequence supplied capabilities:

| Remaining seam | Current behavior |
| --- | --- |
| Compatibility facade | Retains read/graph names and delegates the local-publication command to snapshot publication. It must not acquire package artifacts, construct snapshots, or mutate activation pointers itself. |

The manifest, carrier-projection, packing, verification, snapshot-assembly,
and activation boundaries remain separate release artifacts. A release manifest
is only one input to the carrier that is packed. The coordinator cannot replace
any of those capabilities: its call contract requires each one explicitly,
including discovery and release-binding validation. The packing service owns
the isolated `npm pack` invocation and tarball validation, while snapshot
assembly owns only the immutable registry artifact.

## Release-first bootstrap and verification

Bootstrap from leaves outward:

1. Verify and pack each leaf capability, beginning with dependencies needed by
   the composition (including manifest projection as it is adopted).
2. Publish/promote those exact artifacts, then make the private runtime depend
   on those exact versions.
3. Build and activate a registry from the resulting artifacts, then exercise
   the served read face and its receipt.
4. Run `check-npm-registry-package-installations-service` against that receipt and registry
   URL. It selects exact `name@version` entries, installs each into a fresh
   temporary directory, and checks the files and declared faces that were
   actually shipped.

That last step is the required exact-artifact test: unit tests and a local
workspace import are useful, but cannot prove that the packed tarball can be
installed and run without source-tree, `workspace:`, `file:`, or `link:`
fallbacks.

## Verdaccio

`verdaccio-services-section` is the ordinary private npm registry currently
used by the repository. The root `.npmrc` and root registry commands address
it at `http://127.0.0.1:4873/`; it owns the active publish/install boundary
for versioned packages.

The immutable-snapshot, receipt, graph, query, and verification services in
this section are additional and potentially competing registry capabilities.
All may coexist. Keep each service's read state, guarantees, and package
population explicit.
