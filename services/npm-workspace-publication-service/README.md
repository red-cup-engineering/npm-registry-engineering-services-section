# npm workspace publication service

This service plans and executes immutable, leaf-first npm publication waves.
Publication is a proof about one exact source graph, not merely a sequence of
successful `npm publish` processes.

Source and released manifests require exact registry versions. Local dependency
protocols are refused before construction or publication. The selected root is
one independent package; its neighbors are never implicit release inputs.
`pin-exact-dependencies --package <dir> --migrate-workspace --plan` can propose
exact `latest` identities and artifact integrity from the canonical registry for
legacy `workspace:*` declarations. Inspect provider compatibility before applying.
An absent or unread release refuses that package's entire write; it does not
authorize a checkout fallback. This implements the Leader's 2026-10-15 correction:
"WE DO NOT WANT TO BE USING WORKSPACE SHIT LIKE THIS WE HAVE A REGISTRY!?!??".

## Release identities and npm channels

Stable carriers use `MAJOR.MINOR.PATCH` and publish only with the npm dist-tag
`latest`. Development carriers use `NEXT_BASE-<tag>.N`; a new channel begins at
`.0` and advances numerically as immutable identities become occupied. For
example, work toward `1.4.0` begins at `1.4.0-dev.0`, may advance through the
`dev` channel, and can move to `1.4.0-rc.0` without altering an earlier carrier.
An explicitly selected prerelease wave defaults its channel to `dev`; stable
release behavior remains unchanged and takes no development channel.

```bash
prepare-release-wave --release-kind prerelease --bump minor --apply
publish-workspace-tiers --tag dev --preflight
publish-workspace-tiers --tag dev --execute
```

Promotion is a stable wave over manifests already carrying a prerelease
identity. It requires the exact prerelease to exist in the authoritative
registry plus an `org.emsenn.npm-promotion-admissions.v1` document whose package
entry names that prerelease, an outcome of `carrier-verified`, and its retained
verification receipt. It removes the prerelease suffix only when the
corresponding stable base is unoccupied. The publisher always passes an explicit `--tag`: stable
versions can move only `latest`, and a prerelease can move only its own named
channel. Stable packages cannot pin prerelease dependencies; prerelease
consumers may pin them exactly. Major, minor, or patch selection remains an
authorized compatibility decision supplied to the planner, not a guess made
from changed filenames.

The science definition lives at
`science-services-section/.../software-services-section/services/versioning-services-section/content/text/glossary/terms/semantic-version.md`.
Operational duties live at
`operations-services-section/.../enterprise-office-services-section/content/text/documents/articles/specifications/semantic-release-operation.md`.

Both preflight and execution call the exported `verifyIsolatedCarrier` contract
to construct the same isolated verification copy for every pending carrier,
install its declared exact registry dependencies (using the already-verified
packed carrier when that dependency is pending in the same wave),
run its admitted `check`, `build`, and `test` lifecycle (or `verify` when those
are absent), and assay the resulting tarball. The final packlist must carry
every effective root entrypoint, concrete export, wildcard-export witness, and
bin promised by the manifest. The packed artifact is then unpacked into an
empty consumer and Node must resolve every concrete public package subpath.
Execution retains those exact
copies and begins registry writes only after the entire pending set passes.
Thus a late-tier lifecycle refusal cannot follow an early-tier publication.
Ordinary CI can invoke the identical single-carrier law with
`verify-package-carrier --package-dir <dir> --registry <url>`. It emits one JSON
object with outcome `isolated-carrier-verified` or
`isolated-carrier-refused`; refusals include the bounded lifecycle evidence.

The module-graph assay parses every packed JavaScript member with exact
the JSNode engine, follows ESM, CommonJS `require`, literal dynamic imports,
package `imports`, and package self-references, and separately marks the graph
reachable from exports, effective main, bins, and literal `node <path>` package
scripts. Relative requests must remain inside the carrier, bare requests must
be declared, runtime edges may not depend only on development dependencies,
and computed runtime requests fail closed. Source-checkout callers must run
`npm ci --ignore-scripts --no-audit --no-fund` in this package first; the
sovereign-only v3 lock is the authority for that bootstrap.

The global manifest preflight checks every selected package before any carrier
is published. When a selected package has a `package-lock.json`, three copies of
each direct dependency assertion must agree:

1. the exact version in `package.json`;
2. the root specification in `package-lock.json` `packages[""]`; and
3. the selected version in `packages["node_modules/<dependency>"]`.

This third comparison catches a common partial-update failure in which the
manifest and lock root both advertise a new internal version while the lock's
actual install graph still selects the old carrier. Refusals are emitted in the
publication command's JSON result under `failures[].evidence.violations`, so a
workflow can report every stale assertion in one pass without scraping prose.
An explicitly optional peer may be absent; if npm selected it, its version must
still equal the declared peer contract.

`audit-semantic-version-policy` is the bounded, JSON-emitting form of the same
front-door rule. It checks only the supplied root (and optional package names or
name prefix), exempts descriptive section metadata, and refuses carrier
manifests without a stable `X.Y.Z` or development `X.Y.Z-tag.N` identity. The
publication preflight runs that policy only over its selected root/package set;
it does not turn the repository into one implicit release workspace.

Use `--summary` for operational observation of a large package estate. The
summary retains scanned, exempt, compliant, finding, and violation counts;
groups violations by exact reason; carries only a bounded finding sample; and
commits the complete finding set by an `ni:///sha-256;...` digest. The live
workspace scan excludes retained `data/captures` and package `test/fixtures`
along with established legacy/archive boundaries. Repository-inclusive
forensics remain a separate scan and are not evidence of current package
compliance.

Callers with semantic runtime requirements can use
`dependencyContractViolations(manifest, lock, { requiredDependencies })`.
The aggregate also binds the lock root's own `name` and `version` to the
manifest, so a regenerated dependency graph cannot retain a previous carrier
identity.
`requiredDependencies` contains names, never duplicated versions: the manifest
owns each version assertion and the shared lock law proves its resolution.

The same law walks every exact runtime, optional, and peer edge in the complete
lock graph using Node's nearest-ancestor `node_modules` resolution order. A
hoisted or nested selection is admitted only at the declared version; missing
and stale transitive selections are reported together with their source and
resolved lock locations.

The semantic graph assay dereferences npm filesystem links according to their
physical target and ancestor resolution, but the publication contract then
refuses every link selection. A sovereign carrier must remain reproducible
without a neighboring checkout whose mutable bytes are outside the lock.

`verify-exact-dependencies --check-locks` applies the same invariant during a
repository assay. Packages that deliberately have no lock remain lockless; a
present lock is treated as an authoritative assertion and must be internally
coherent.

## Runtime provider catalogs

`form-node-runtime-provider-catalog` closes the reachable runtime graph for one
or more declared workspace entry packages. Each entry's npm v3
`package-lock.json` is its resolution authority. Exact matching workspace
identities become source providers. Every other required dependency is
resolved from its requiring package location with npm's ancestor/link law; the
selected exact version must satisfy the manifest range and carry a
integrity plus same-authority registry address. The registry's matching
`dist.integrity` and tarball are then downloaded and verified without invoking
npm or choosing a registry-latest version.
Development-only and unreachable workspace packages are not projected into the
runtime closure. Missing optional dependencies remain absent. Missing, stale,
or non-satisfying lock selections, foreign artifact authorities, identity
drift, integrity drift, duplicate workspace identities, and multiple selected
versions of one package are refused.

```bash
form-node-runtime-provider-catalog \
  --workspace /committed/source \
  --entries /admission/runtime-entry-roots.json \
  --registry https://us-central1-npm.pkg.dev/project/repository/ \
  --output /ephemeral/runtime-provider-admission
```

The entry file is an array of `{ "id": "daily", "name": "@scope/root" }`
claims. The resulting `NodeRuntimeProviderCatalog` contains one independent
admission per entry, each with source directories and immutable
`{name, version, integrity, tarballPath}` providers. It also binds each
requiring package/location, requested range, selected lock location, exact
version, integrity, and resolved registry address so the materializer can
re-attest the selection without consulting a registry. Different entries may
lawfully select different exact versions, while a single entry still has one
provider singleton per package name. The catalog can be passed directly to
`materialize-node-runtime-release --providers`. Registry
credentials are read only from the existing short-lived `NODE_AUTH_TOKEN`
authority and are never written into the catalog.

## Owner namespace debt

`audit-owner-package-namespaces --services-root <services-directory>` reads the
same live manifest graph as publication tooling and emits a deterministic JSON
ledger for the current owner law: engineering packages use
`@red-cup-engineering`, science packages use `@lenticule-science`, and
operations packages use `@coesite-operations`. The ledger names exact manifest
consumers and proposed-name collisions. It does not rename packages: changing
an npm identity also requires coordinated source imports, lockfiles, registry
publication, and consumer migration.

## Transactional package-lock reconciliation

`reconcile-package-locks` accepts an explicit JSON array of `{id, path}`
package roots. It copies the complete declared topology into an isolated Linux
temporary workspace, pins Node 24.19.0 and npm 11.17.0, and gives npm only the
declared HTTPS registry plus the short-lived `NODE_AUTH_TOKEN`. Every root must
produce one package-lock v3, pass the shared dependency and registry-authority
policy, complete `npm ci`, and complete its declared
`verify` lifecycle before any repository lock is written. Source fingerprints
are checked at the prewrite barrier; one refusal or drift leaves all repository
locks unchanged. Successful locks are staged beside their targets and renamed
only after the all-roots barrier.

`reconcile-package-locks-from-releases` is the carrier-backed form of the same
transaction. It accepts only explicit `{manifest, artifactPath, integrity}`
release admissions, calls the snapshot assembly service, exposes that closed
snapshot through the filesystem-only registry read service on loopback, and
then calls `reconcilePackageLocks` with the durable HTTPS registry as the lock
authority. The temporary read face has no upstream fallback; generated
loopback coordinates become npm artifact coordinates before
validation, `npm ci`, or the repository write barrier.

```bash
reconcile-package-locks \
  --workspace /committed/source \
  --roots /admission/package-roots.json \
  --registry https://us-central1-npm.pkg.dev/project/repository/
```

### Receive one packed artifact

`receive-packed-registry-artifact before|after` reads `PACKAGE`, `VERSION`,
`PACKAGE_ARCHIVE` and `REGISTRY` from the environment. pnpm receives authentication
through its configured environment or user configuration; the command carries
no credential in its arguments. The before observation permits publication only
when the exact metadata read establishes absence. An occupied identity must match
the packed SHA-512 (or its legacy SHA-1 when no integrity is advertised); the after
observation requires those same bytes. This receives registry metadata about a
packed artifact, not installed closure or machine promotion. Shared CI hires this
declared bin from the mounted publication owner.

Registry metadata readers treat only HTTP 404 as absence. Other HTTP failures
refuse the read, malformed identities are refused, and transport failure stays
unread. Recovery refuses publication when its prior observation is unread.
