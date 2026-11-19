# npm registry services

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

This section is decomposing the bespoke registry into small **capability
packages** and private **runtime compositions**. A capability has one bounded
job, a release class, and (when releasable) is consumed through its exact
published version. A runtime composition owns deployment-specific sequencing
and side effects; it is not a substitute for a capability package simply
because it lives beside one in the workspace. This distinction keeps a clean
release artifact—not a checkout or a workspace link—as the unit future agents
test and depend on.

## The house registry

`npm-registry-serving-service` is registry.561.group: the npm registry
protocol as npm and pnpm speak it (conditional requests, login tokens, search,
audit), served from each house package's facts. Those facts are an
append-only EAVT journal per package, with tarballs stored by RFC 6920 NI
address. It runs as an application of Cold Red Gate's MetroPlat instance,
with its standalone process as the ingress's fallback over the same store.
It owns the live publish and install boundary for every house package; see
its README.

## Extracted capabilities

| Package | Present responsibility | Release status |
| --- | --- | --- |
| `npm-package-tree-discovery-service` | Walks package trees, admits explicitly declared release candidates, and reports deliberate skips/collisions. | Releasable CLI |
| `npm-registry-graph-engineering-services-section` | Derives dependency, history, and witness graphs from registry receipts and renders dependency/history DOT. | Releasable CLI |
| `npm-registry-read-service` | Serves the built registry's read-only npm face: health checks, packuments, tarballs, and receipt files; `serve-npm-registry-read` deploys that face as a standalone process. | Releasable library and CLI |
| `npm-registry-receipt-recovery-service` | Rebuilds and validates a registry receipt from served metadata and tarballs. | Releasable library |
| `npm-artifact-integrity-service` | Measures package-artifact bytes and npm SHA-1/SHA-512 digests, then verifies declared measurements. | Releasable library |
| `npm-cache-release-recovery-service` | Audits package-lock evidence and recovers only integrity-matching exact release tarballs from npm's local content cache. | Releasable library |
| `npm-registry-snapshot-verification-service` | Admits complete immutable snapshots by checking receipt, packument, tarball, path, URL, and integrity closure. | Releasable library |
| `npm-registry-snapshot-assembly-service` | Assembles supplied release artifacts and an optional base snapshot into metadata, receipt, npmrc, paths, and deterministic dist-tags, then admits the snapshot. | Releasable library |
| `npm-registry-snapshot-activation-service` | Atomically switches host-local `current` and `last-good` pointers among already verified immutable snapshots. | Releasable library |
| `npm-registry-engineering-services-section` | Exports `./select-npm-registry-packages` to select exact releases and `./check-npm-registry-package-installations` to install and inspect exact receipt entries in clean temporary projects. | Releasable library |
| `npm-registry-query-service` | Answers existence, name search, direct dependencies/dependents, and standard package interfaces (`exports`, `imports`, main/module/types entrypoints, normalized bins, scripts, and platform constraints) against a built registry or its HTTP face. | Releasable CLI |
| [npm workspace publisher](https://github.com/red-cup-engineering/npm-workspace-publication-computer-code-development-systems-engineering-services-section) | Publishes workspace packages in dependency order and verifies their registry artifacts. Its source is owned by Computer Code Development Systems. | Releasable CLI |
| `npm-registry-user-service` | Manages the registry's htpasswd users directly ({SHA} scheme, dependency-free): list, add with typed refusals, remove; passwords only from the environment. | Releasable CLI |
| `npm-registry-a2a-projection-service` | Produces/executes A2A registry-snapshot messages; deliberately starts no server. A contracted-agent runtime supplies that transport. | Private projection capability |
| `npm-release-manifest-projection-service` | Projects manifests into publishable form, removing house metadata and replacing local dependency protocols only through exact coordinated-release bindings. | Releasable library, extraction/wiring in progress |
| `npm-carrier-projection-service` | Projects a controlled package carrier, excluding repository and instance territories plus nested packages; can substitute the already-projected release manifest and refuses symbolic links. | Releasable library |
| `npm-registry-release-coordinator-service` | Schedules bounded source preparation under an injected compute lease and delegates discovery, release-binding validation, manifest/carrier projection, packing, assembly, verification, and optional activation to injected exact capabilities. | Releasable library |
| `npm-registry-snapshot-publication-service` | Composes the coordinator and snapshot-activation service to build `host/snapshots/name` and atomically advance `host/current`; it never restarts a server or swaps a live directory. | Releasable CLI |

Use `render-npm-registry-graph` from the graph package and
`publish-npm-registry-snapshot` from the snapshot-publication package. The
house registry runtime is operated by `npm-registry-serving-service`.

## What is still in the composition

The coordinator schedules bounded work, acquires and releases its injected
lease, cleans staging space, and sequences the supplied capabilities.

The manifest, carrier-projection, packing, verification, snapshot-assembly,
and activation boundaries remain separate release artifacts. A release manifest
is only one input to the carrier that is packed. The coordinator cannot replace
any of those capabilities: its call contract requires each one explicitly,
including discovery and release-binding validation. The packing service owns
the isolated `npm pack` invocation and tarball validation, while snapshot
assembly owns only the immutable registry artifact.

## Archive admission

The artifact-integrity service exports `./admit-npm-package-archive` for
producers and snapshot consumers. It admits gzip tar bytes against an exact
package name, version, SHA-512 integrity and runtime dependency maps from
the supplied release manifest, including whether declared peers are optional. It reads the archive without extracting or
installing anything and rejects missing, duplicate or oversized manifests.
It returns measured archive identity, not a source or publication receipt.

## Release-first bootstrap and verification

Bootstrap from leaves outward:

1. Verify and pack each leaf capability, beginning with dependencies needed by
   the composition (including manifest projection as it is adopted).
2. Publish/promote those exact artifacts, then make the private runtime depend
   on those exact versions.
3. Build and activate a registry from the resulting artifacts, then exercise
   the served read face and its receipt.
4. Feed a JSONL request naming the receipt, npm configuration, and exact
   `name@version` entries to
   `node node_modules/@red-cup-engineering/npm-registry-engineering-services-section/scripts/check-npm-registry-package-installations.mjs`.
   The checker installs each entry into a fresh temporary directory and
   inspects its shipped files and declared interfaces.

The installer requires a measured tarball URL and SHA-512 from the registry
receipt. It checks the new npm lock against both, then separately checks the
installed package identity and interfaces. A matching version alone is not
acceptance; a missing lock or different archive is a refusal.

That last step is the required exact-artifact test: unit tests and a local
workspace import are useful, but cannot prove that the packed tarball can be
installed and run without source-tree, `workspace:`, `file:`, or `link:`
fallbacks.

## Verdaccio

`verdaccio-engineering-services-section` is the earlier private registry. Its store layout
(`<name>/package.json` beside the tarballs) is the one
`npm-registry-serving-service` received as facts and still writes as a
projection, so a Verdaccio pointed at that store serves it. Nothing publishes
through Verdaccio.

The immutable-snapshot, receipt, graph, query, and verification services in
this section are additional registry capabilities over registry artifacts.
They read registry.561.group or its snapshots, or publish to it; none of them
is another registry. Keep each service's read state, guarantees, and package
population explicit.

## Native receiving prerequisite

The selection and installation-check commands use strict native Node argument parsing for `--help`/`-h`, retaining their JSONL and request admission contracts. All portable original suites and CLI argument tests are shipped and enrolled in `receivingTests`. Tests use temporary local data and injected fetch/process boundaries, not a live registry installation. Exact supplier selections refer to the genuine current native cohort. Source and packed behavior evidence does not establish issued registry artifacts, frozen installation of this package, or production activation; no frozen dependency lock is supplied by this source candidate.
