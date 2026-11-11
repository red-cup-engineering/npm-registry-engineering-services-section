# House npm registry serving

This package is the house npm registry (registry.561.group): the npm registry
protocol as npm and pnpm speak it, served from the house's package facts. It
runs as a MetroPlat hosted application on an instance's own listener, or as a
standalone process; both are the same registry over the same store.

## Canonical R2 profile

The service also exports `./r2-registry`, the existing house registry's Worker/R2 storage profile. It accepts the normal prepared npm JSON document through the original publisher port, sharing native wire admission and the static archive/dependency gate. Operators select the original bucket, canonical origin, exact house scopes/names and qualified native publisher policy in their own deployment data. `nodejs_compat` and the selected original dependencies are packaged by the admitted Code provider; there is no source fetch, pack or install at a publication request.

Existing Basic and native npm-token clients delegate identity to the original same-zone native origin. The explicit original authenticated-house-publisher policy still restricts writes to declared house names. The existing Bearer publisher can use the same prepared path; raw object writes cannot bypass immutable archive or metadata CAS checks. House reads and gate supplier reads stay in R2. Non-house metadata, version, dist-tag and tarball reads (GET/HEAD) are answered by the Worker directly from the public npm registry (`uplink`, default `https://registry.npmjs.org`, bounded by `uplinkTimeoutMs`), with credentials stripped, the uplink's status passed through, tarball URLs in documents moved to this registry's origin by a streamed rewrite, and nothing public written to R2; they never take a second hop through the native origin. Only identity/login and the security audit request still go to the original native origin. Canonical house catalogue search and standalone tag/deprecation mutations are explicit holds until their R2-owned operations are qualified; the native profile's original operations remain unchanged and must not be presented as fresh canonical R2 state.

One accountable original input per package/version is received before effects. An immutable collision, CAS miss or unknown effect retains input/artifacts instead of replaying a publication. Exact received duplicates do not allocate/reuse a cleanup key. Publication received with cleanup unreceived remains a distinct reported obligation. The private input namespace never serves public bytes.

`npm test` includes the native and R2 protocol suites. Separate integration receiving uses `test:landed-registry-port` with `GITHUB_LANDING_PUBLICATION_MODULE` and `PREPARED_NPM_PUBLICATION_INPUT` selecting the original producer/input; `test:legacy-r2-publication` uses `LEGACY_R2_PUBLICATION_CLI` to receive the exact held legacy source. Those locators select receiving inputs and grant no fabrication or publishing authority. See the operative requirements/design for the protocol and automatic18822 transport contract.

## Data: facts, blobs, and what is projected from them

What the registry knows about a house package is what has happened to it, kept
as EAVT rows (`{e, a, v, t}`, the shape `eavt-services-section` reads) in an
append-only journal per package, and its tarballs, each kept once under its
RFC 6920 SHA-256 NI address:

```
<storage>/<name>/facts.jsonl           publications, dist-tag moves, deprecations, readme
<storage>/-/blobs/sha-256/<d0d1>/<d>   tarball bytes, located by the shared ni-path formula
```

A row's entity is the package's Package URL (`pkg:npm/%40scope/name`, or
`…@1.0.0` for one version), so facts do not change when the registry's origin
does. The vocabulary is in [`src/facts.mjs`](src/facts.mjs). A version's first
publication is its publication: a later one is a contradiction, kept as
evidence and kept out of every document. Tarball URLs, `time`, `_rev`,
maintainers, and the top-level `description`/`repository`/`license`/…
(presented from latest, as npm's registry presents them) are derived, never
stored.

Every document served for a house package is a pure projection of its rows
([`src/projection.mjs`](src/projection.mjs)): the full packument, the
abbreviated install document, a version manifest, dist-tags, a search entry.
Each is rendered once per journal state and cached until the journal changes.

The store keeps one more projection on disk: `<name>/package.json` and
`<name>/<file>.tgz` (hard links to the blobs), the layout the earlier
Verdaccio-shaped store used. An earlier registry release, or Verdaccio, still
serves this store after a rollback; nothing reads that layout as truth while a
journal exists.

## Reception of the earlier layout

A package the earlier store wrote (`package.json`, no journal) is served by
reading its packument as the facts it records, in memory, before anything is
written. Reception ([`src/reception.mjs`](src/reception.mjs)) writes those
facts down: it adopts each tarball into the blob store by hard link, checks it
against its advertised integrity, and writes the facts only if their projection
serves every field the earlier store served, unchanged. A package that would
not be served the same is left exactly as it was and reported. Tarballs are
measured as streams, so a store is received without holding any of them. A
scoped version the retired publisher left under npm's attachment key
(`@scope/name/@scope/name-1.0.0.tgz`) is recovered from there and linked at its
leaf, only when its bytes are the advertised ones. A journaled
package is reconciled with its `package.json`: a version found only there (an
earlier release published it after a rollback) is received, never lost.

Serving performs no store-wide startup maintenance by default. Requested
packages retain the earlier-layout read compatibility described above.
`receive-registry-store CONFIGURATION [--dry-run]` explicitly receives the
store; `--dry-run` writes nothing. Its `--remove-public-leftovers` option
explicitly invokes the original public-cache cleanup before receiving and
cannot be combined with dry-run. Owners can deliberately select the former
background startup behavior with the boolean `receiveAtStart: true`.

This separation is required by the observed Cold Red Gate startup on
2026-10-24: the main host was reading a registry journal while its process
had accumulated 15 GB of physical reads, alongside severe host CPU, memory
and I/O pressure. Serving or restarting an unrelated application must not
schedule a migration of every package and measurement of its tarballs.
The existing native maintenance operations retain those capabilities.
Against the 1,422 house
packages registry.561.group served on 2026-10-21, every package's full and
abbreviated documents were identical before reception, after it, and on a
second (no-op) run.

## Hosting

**MetroPlat.** Declare the registry among a MetroPlat instance's
`applications`:

```json
{ "module": "@red-cup-engineering/npm-registry-serving-service/application",
  "export": "npmRegistryHostedApplication",
  "configuration": { "hosts": ["registry.561.group"], "origin": "https://registry.561.group",
                     "storage": ".local/state/561-group/registry/storage",
                     "htpasswd": ".local/state/561-group/registry/htpasswd",
                     "privateScopes": ["@red-cup-engineering", "…"] } }
```

The instance's entrance answers every request whose Host is one of `hosts`
with the registry, ahead of the instance's own sign-in and routes; the registry
authenticates its own state changes. The native listener negotiates
compression. A host may build its entrance more than once; every build gets the
same registry, so one store has one writer queue in a process. The
configuration is exact: an unknown key, or an origin that is not one of the
hosts, is refused.

**Standalone.** `serve-house-registry CONFIGURATION` (or
`NPM_REGISTRY_CONFIGURATION`) listens on `127.0.0.1:$NPM_REGISTRY_PORT` (18821),
gzips JSON for clients that ask, and with `NPM_REGISTRY_ACCESS_LOG=1` writes one
JSON line per answered request to stderr.

Writers serialize per package within a process and across processes: a lock
file beside the journal, taken over when its holder has exited. The standalone
face may serve the same store as a MetroPlat instance, for example as a
recovery face.

## Protocol

- **Metadata** (`GET`/`HEAD /<name>`): npm's abbreviated
  `application/vnd.npm.install-v1+json` when the client prefers it at least as
  much as JSON, else the full document; `Vary: Accept` either way. Unknown
  timestamps and shrinkwrap status are not invented.
  Reference: https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md
- **Revalidation**: every packument carries a strong `ETag` per
  representation and a `Last-Modified`. `If-None-Match` (or, without it,
  `If-Modified-Since`) is answered 304 until something happens to the package.
  pnpm and npm send both; a house packument is `Cache-Control: no-cache`, so a
  publish is seen at once and an unchanged package costs a 304. A public
  packument is `public, max-age=300`, as npm's registry sends it. A tarball is
  `public, max-age=31536000, immutable` with its shasum as its ETag.
- **Public names** are the uplink's (registry.npmjs.org), never written to
  storage: held in memory, at most `publicMetadataBytes`, least recently used
  first out, fresh for `uplinkMaxAgeMs`, answered stale only while the uplink
  fails. Overlapping reads for one name share one fetch. Client credentials
  never reach the uplink.
- **Signing in**: publishers are the htpasswd file's (bcrypt; re-read when it
  changes, so the operator adds one without a restart). npm's Basic credential
  (`username`/`_password`) works as before. `npm login` (npm falls back from
  web login, which is not offered) signs in with the publisher's password at
  `PUT /-/user/org.couchdb.user:<name>` and receives an `hnr_` token for
  `_authToken`. Only its SHA-256 is kept, in `tokens.jsonl` beside htpasswd
  (`tokens` to place it elsewhere). `npm logout` revokes it. Signing in never
  creates an account.
- **Audit**: `npm audit`'s bulk advisory request is forwarded to the uplink
  with the house's names taken out; the uplink has no advisories for them, and
  the house's dependency inventory is not the uplink's to read.
- **Search**: `GET /-/v1/search` over the house packages (`scope:` and
  `keywords:` qualifiers; a name match ranks above a description match).

## Publication

The npm client publishes a manifest and attached bytes. For scoped packages npm
may name the attachment `@scope/name-version.tgz`; the registry admits either
wire name and records the canonical `name-version.tgz`. Before writing, it
validates the complete publication: exact package and version identities, one
artifact per version, its canonical filename, canonical base64 and declared
length, supplied SHA-1/SHA-512 digests, a declared repository, and each tag's
version target. Unbound attachments, missing artifacts, conflicting bytes, and
occupied versions are refused, and nothing is written. npm provenance-bundle
attachments are not supported; house publication uses `--provenance=false`.

A publication then places each tarball in the blob store, links its leaf,
appends its facts (publication, tags, and the readme the tarball ships when it
is latest's), and rewrites the earlier-layout projection. A failure before the
append leaves at most an unadvertised complete artifact; retry can reuse those
exact bytes, but cannot replace them. A journal line cut short by an
interrupted append is not read, and is cut back before the next append.

## Publish gate

A new version is read before it is stored. The registry opens its tarball in
memory (gzip, ustar, PAX; bounded inflation; no link or device members) and
reads it; it never extracts to disk and never runs anything from it. A 400 names
every problem at once, per version, and nothing is stored. The checks, by the
kind each violation reports:

- `export-target`, `bin-target`: an `exports` target (under `import`, `require`,
  `node`, `module-sync`, `default`, or none) or a `bin` target that the tarball does
  not contain. A pattern target must match at least one shipped file.
- `undeclared-import`: a `.mjs`/`.cjs`/`.js` module (outside `node_modules`) with a
  static `import`, `export … from` or `import("literal")` of a house-scoped
  specifier whose package is not in dependencies, peerDependencies or
  optionalDependencies. The package's own name is judged by its own `exports`
  (`self-import`). Modules are read with the house JavaScript parser
  (`@red-cup-engineering/javascript-parser-service`), so comments and strings are not
  imports; a module that names a house scope but does not parse is a `source` violation.
- `receiving-test`: an explicit `receivingTests` entry that is absent from the
  archive, or a receiving declaration that is not an array of original file paths.
  The declared roots and their literal local module closure may use
  `devDependencies` when they are outside the public Node runtime closure.
  The same published-version and export checks apply to those suppliers.
  Public `exports`, `main`, and `bin` entries retain the runtime dependency rule,
  including helpers shared with receiving. A package without `exports` exposes
  every subpath, so its receiving files remain public. Consumer lifecycle/start
  commands whose runtime graph is not explicit also retain the runtime rule.
- `dependency`: a declared house dependency with no published version satisfying
  its range (npm semver; a dist-tag also resolves), or a specifier a registry
  cannot resolve (`workspace:`, `file:`, …).
- `dependency-subpath`: an import whose subpath the highest published version
  satisfying the range does not export, `*` patterns and `./package.json` included.
  The message lists the subpaths it does export and any versions that export the
  one imported. A dependency with no `exports` exposes all its files and is not judged.
- `tarball`: bytes that are not an npm tarball, no readable package.json, or a
  package.json naming another package or version.

House scopes default to `@red-cup-engineering`, `@lenticule-science`, `@561-group`,
`@coesite-operations`, `@causeway-services`, `@emsenn` and the registry's
`privateScopes`; configure `houseScopes` to change them, `publishGate: false` to
turn the gate off. Imports of other packages and `node:` builtins are not checked.
Relative, package-import and self-reference edges, including literal `require()`,
are followed to keep public runtime modules out of the development receiving
context. Relative target availability and computed imports retain their existing
gate interpretation; house `require()` imports are not supplier-assayed here.

## Metadata updates

A published version is fixed: tarball, integrity and manifest. What moves is
facts about versions, all of it authenticated:

- `npm deprecate` GETs the packument and PUTs it back whole, with no attachments.
  A PUT without attachments is accepted only if every published version is present
  and identical to the served one except for `deprecated` (an empty message clears
  it), and `dist-tags` and `maintainers` are unchanged; anything else is a 409
  naming what differs. A version that would be new needs its tarball (400).
- Dist-tags: GET `/-/package/<name>/dist-tags[/<tag>]`, PUT a version string to
  `.../dist-tags/<tag>`, DELETE `.../dist-tags/<tag>`, on house packages only. A
  tag must name a published version and must not be a valid semver range;
  `latest` is moved, not removed.
- `npm unpublish` (PUT `/-rev/`, DELETE) is a 405: versions are never removed.
- `npm owner` is a 409: maintainers are the publishers of record.

## Memory is bounded by admission

The registry runs in a small host, and its heap aborted twice on 2026-10-18 (V8
heap exhaustion) under landing publications. It bounds what it holds by
refusing, not by hoping: one publish body is in memory at a time (publishes are
taken in turn); a body over `maxPublishBytes` (64 MiB) is refused 413 and never
read past the cap; a stored tarball is streamed from disk with its length
instead of held; an uplink tarball over `maxUplinkTarballBytes` is not fetched
into memory; and while the V8 heap is within a fifth of its limit a new publish
is answered 503 with Retry-After instead of growing the heap until the process
aborts. Public metadata and house projections each stay in a 32 MiB
least-recently-used budget (`publicMetadataBytes`, `houseMetadataBytes`).

The publication gate retains only each supplier's version names, dist-tags and
export declarations. It releases the complete historical packument, including
unrelated manifest fields and READMEs, before requesting another supplier. This
keeps one publication from pinning metadata outside the serving cache's budget
throughout parsing. Highest-version selection, aliases, tagged selections and
the original missing-export diagnostics use the same received evidence. The
native retention case explicitly collects discarded documents in an isolated
test process; production collection policy and the heap admission threshold are
unchanged.

## Receiving

`npm test` runs every test; `receivingTests` ships the enrolled set with the
package. They cover:

- **Transactions**: complete-transaction refusal, occupied-byte and version
  immutability, concurrent publications, and failed-write preservation.
- **Facts**: the facts and blobs a publication writes, the projections served
  from them, and reception of the earlier layout (including a refused packument
  and a version an earlier release published after a rollback).
- **Store integrity**: cut-short appends, contradictions, two registries
  sharing a store, and a stale lock.
- **Protocol**: revalidation and cache headers, the full document's
  npm-derived fields, sign-in tokens and htpasswd reload, audit filtering, and
  the hosted-application contract.
- **Real clients**: the installed npm client publishes, installs, deprecates,
  tags, signs in at a terminal, logs out, and is refused unpublish and
  republication. The installed pnpm client publishes and installs, and its
  cached metadata is revalidated with a 304.

The publish-gate tests cover each violation kind against real tarballs built
in the tests, and (outside the enrolled set, because they carry fixtures) the
real published tarballs of semiotic-eavt-services-section 0.1.4 and 0.1.5 and
kalshi-services-section 0.1.31. The packed-package regression installs the
actual package tarball, with its installed dependency closure, into an empty
offline consumer, and checks the shipped receiving tests and the
`registry-uplink-prune` script. Fixtures, credentials, and consumers are
disposable local data; no test publishes to an external registry.

A source test pass is not live receiving. The installed service must separately
demonstrate the same protocol and artifact/consumer conditions through the
authorized release route before a deployment change can be claimed.


Conflicting native/R2 package versions are quarantined through operator observations. Full metadata responses exclude those versions and tags and include `x-561-registry-conflicts` evidence with a derived ETag. Exact conflicted version, tag and archive reads return409; unaffected products remain available. The original dependency gate sees the same quarantine. Durable originals are preserved, and publication CAS always merges raw metadata. A native-only reservation accepts only the exact observed full manifest/SRI/source through ordinary authenticated publication and the complete original gate. It does not grant permission or waive any check.

Every node applies the same quarantine with the same module (`src/registry-identity-conservation.mjs`): the node's `identityConservation` setting is the typed policy or the path of a record holding it, and defaults to `data/records/registry-identity-conservation-records/registry-identity-conservation.json` when the node serves that record's origin. That record is the Worker's carrier too: its `conflicts` and `reservations` arrays are the `REGISTRY_IDENTITY_CONFLICTS` and `REGISTRY_IDENTITY_RESERVATIONS` bindings. A node answers a quarantined version, tag or archive 409 with the Worker's body, serves full and install packuments without it but with `x-561-registry-conflicts`, refuses to publish or tag it, and never receives it (or a tag naming it) from a peer. A node may hold either recorded identity; any other is drift and fails closed. Node search selects its version and descriptive metadata from the same identity-checked surviving versions and tags. A package with no surviving version is absent from search results, totals and pagination; stored originals remain untouched. This does not enable the separately held canonical R2 catalogue search.

A legacy conflict may explicitly record an absent source as `gitHead: null`; its full manifest fingerprint, archive integrity and URL remain mandatory. Native reservations require an exact source commit. When operator records exceed one platform variable's limit, keep ordinary settings in `REGISTRY_CONFIGURATION` and supply both `REGISTRY_IDENTITY_CONFLICTS` and `REGISTRY_IDENTITY_RESERVATIONS` as JSON arrays. Partial split settings or an embedded policy combined with split settings fail closed.

An operator `publicationHold` of type `RegistryIdentityConservationHold`, with `recordSha256` and governing GitHub `work`, locks ordinary prepared publication with423. Exact reserved native artifacts can still be conserved through normal authentication and the complete gate, with no tag or unrelated packument changes. Reads stay available; a publisher restart or URL change does not remove this restriction. The hold does not settle old input custody or authorize retries.

## Original prepared publication continuation

An interrupted publication can outlive its client or the Worker's resource slice.
`POST /-/publication-inputs/<encoded-package>/<version>/resume` continues the
original receiver using the original raw publication JSON and its SHA256 in
`x-561-input-sha256`. It authenticates the existing publisher and qualifies the
package, version and exact input bytes. A held input must belong to that publisher
and match both its measured bytes and stored identity. Other inputs refuse.

Continuation executes the same conservation policy and publication gate. It uses
the original atomic create-once claim, immutable archive creation and metadata CAS;
an absent read never grants permission to overwrite another operation. A complete
result receives manifest, archive and tags before retiring exact input custody.
Failure retains known server custody, including when new validation refuses an old
input. Ordinary PUT continues to refuse occupied input; custody GET and arbitrary
object writes remain unavailable. No source acquisition, repacking, release
allocation, tag rollback, billing change or alternative shelf is part of this move.

The gate accepts an optional exact-manifest reader for literal immutable pins.
The R2 receiver reads the selected canonical version without projecting all
historical exports; quarantined versions still refuse. Ranges, tags, missing
versions and subpath diagnostics retain the original packument resolver.

Read-only native receiving of the retained harness183 archive measured 7,472,288
metadata bytes and 3,240.725 CPU milliseconds through the history port, versus
216,309 bytes and 765.03 CPU milliseconds through the exact-manifest port. Both
returned no violations. These are native observations, not Worker CPU or billing
claims; deployment requires separate receiving.

## Peers: each node serves its own registry

A node runs `bin/serve.mjs` over its own store. Its configuration may declare `peers`: `{"kind":"registry","name":"…","url":"https://…"}` (another node) or `{"kind":"bucket","name":"…","bucket":"…","accountIdEnvironment":"…","accessKeyIdEnvironment":"…","secretAccessKeyEnvironment":"…"}` (an R2 bucket laid out as the canonical R2 profile lays it, read through its S3 API; credentials are named by environment variable, never held in the declaration). A house name the store does not hold is received from the peers on first use and before a publication builds on it; `bin/receive-from-peers.mjs CONFIGURATION [--all-bytes] [--lockfile pnpm-lock.yaml] [NAME]…` receives ahead of use. Versions' facts are received whole; tarball bytes for the versions a lockfile names (or all with `--all-bytes`), the rest when first requested. No peer is canonical: tarballs are kept only if they are their advertised integrity, named by the NI address of their own bytes; a held version is never replaced; other bytes for it are reported as a divergence. A publish on a node writes only that node. `publicTarballs: "proxy"` with `cachePublicTarballs: true` keeps public tarballs on this node's disk after the first fetch.

## From the copy in red-cup-engineering/jsnode-packaging-engineering-services-section

This package is the Group npm registry (registry.561.group): the npm registry
protocol as npm and pnpm speak it, served from the Group's package facts. It
runs as a MetroPlat hosted application on an instance's own listener, or as a
standalone process; both are the same registry over the same store.

## Data: facts, blobs, and what is projected from them

What the registry knows about a Group package is what has happened to it, kept
as EAVT rows (`{e, a, v, t}`, the shape `eavt-services-section` reads) in an
append-only journal per package, and its tarballs, each kept once under its
RFC 6920 SHA-256 NI address:

```
<storage>/<name>/facts.jsonl           publications, dist-tag moves, deprecations, readme
<storage>/-/blobs/sha-256/<d0d1>/<d>   tarball bytes, located by the shared ni-path formula
```

A row's entity is the package's Package URL (`pkg:npm/%40scope/name`, or
`…@1.0.0` for one version), so facts do not change when the registry's origin
does. The vocabulary is in [`src/facts.mjs`](src/facts.mjs). A version's first
publication is its publication: a later one is a contradiction, kept as
evidence and kept out of every document. Tarball URLs, `time`, `_rev`,
maintainers, and the top-level `description`/`repository`/`license`/…
(presented from latest, as npm's registry presents them) are derived, never
stored.

Every document served for a Group package is a pure projection of its rows
([`src/projection.mjs`](src/projection.mjs)): the full packument, the
abbreviated install document, a version manifest, dist-tags, a search entry.
Each is rendered once per journal state and cached until the journal changes.

The store keeps one more projection on disk: `<name>/package.json` and
`<name>/<file>.tgz` (hard links to the blobs), the layout the earlier
Verdaccio-shaped store used. An earlier registry release, or Verdaccio, still
serves this store after a rollback; nothing reads that layout as truth while a
journal exists.

## Reception of the earlier layout

A package the earlier store wrote (`package.json`, no journal) is served by
reading its packument as the facts it records, in memory, before anything is
written. Reception ([`src/reception.mjs`](src/reception.mjs)) writes those
facts down: it adopts each tarball into the blob store by hard link, checks it
against its advertised integrity, and writes the facts only if their projection
serves every field the earlier store served, unchanged. A package that would
not be served the same is left exactly as it was and reported. Tarballs are
measured as streams, so a store is received without holding any of them. A
scoped version the retired publisher left under npm's attachment key
(`@scope/name/@scope/name-1.0.0.tgz`) is recovered from there and linked at its
leaf, only when its bytes are the advertised ones. A journaled
package is reconciled with its `package.json`: a version found only there (an
earlier release published it after a rollback) is received, never lost.

The registry receives its store once at start, in the background, while it
already answers (`receiveAtStart: false` turns that off), and reports one JSON
line on stderr. `receive-registry-store CONFIGURATION [--dry-run]` does the
same on demand; `--dry-run` writes nothing at all. Against the 1,422 house
packages registry.561.group served on 2026-10-21, every package's full and
abbreviated documents were identical before reception, after it, and on a
second (no-op) run.

## Hosting

**MetroPlat.** Declare the registry among a MetroPlat instance's
`applications`:

```json
{ "module": "@red-cup-engineering/npm-registry-serving-service/application",
  "export": "npmRegistryHostedApplication",
  "configuration": { "hosts": ["registry.561.group"], "origin": "https://registry.561.group",
                     "storage": ".local/state/561-group/registry/storage",
                     "htpasswd": ".local/state/561-group/registry/htpasswd",
                     "privateScopes": ["@red-cup-engineering", "…"] } }
```

The instance's entrance answers every request whose Host is one of `hosts`
with the registry, ahead of the instance's own sign-in and routes; the registry
authenticates its own state changes. The native listener negotiates
compression. A host may build its entrance more than once; every build gets the
same registry, so one store has one writer queue in a process. The
configuration is exact: an unknown key, or an origin that is not one of the
hosts, is refused.

**Standalone.** `serve-house-registry CONFIGURATION` (or
`NPM_REGISTRY_CONFIGURATION`) listens on `127.0.0.1:$NPM_REGISTRY_PORT` (18821),
gzips JSON for clients that ask, and with `NPM_REGISTRY_ACCESS_LOG=1` writes one
JSON line per answered request to stderr.

Writers serialize per package within a process and across processes: a lock
file beside the journal, taken over when its holder has exited. The standalone
face may serve the same store as a MetroPlat instance, for example as a
recovery face.

## Protocol

- **Metadata** (`GET`/`HEAD /<name>`): npm's abbreviated
  `application/vnd.npm.install-v1+json` when the client prefers it at least as
  much as JSON, else the full document; `Vary: Accept` either way. Unknown
  timestamps and shrinkwrap status are not invented.
  Reference: https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md
- **Revalidation**: every packument carries a strong `ETag` per
  representation and a `Last-Modified`. `If-None-Match` (or, without it,
  `If-Modified-Since`) is answered 304 until something happens to the package.
  pnpm and npm send both; a Group packument is `Cache-Control: no-cache`, so a
  publish is seen at once and an unchanged package costs a 304. A public
  packument is `public, max-age=300`, as npm's registry sends it. A tarball is
  `public, max-age=31536000, immutable` with its shasum as its ETag.
- **Public names** are the uplink's (registry.npmjs.org), never written to
  storage: held in memory, at most `publicMetadataBytes`, least recently used
  first out, fresh for `uplinkMaxAgeMs`, answered stale only while the uplink
  fails. Overlapping reads for one name share one fetch. Client credentials
  never reach the uplink.
- **Signing in**: publishers are the htpasswd file's (bcrypt; re-read when it
  changes, so the operator adds one without a restart). npm's Basic credential
  (`username`/`_password`) works as before. `npm login` (npm falls back from
  web login, which is not offered) signs in with the publisher's password at
  `PUT /-/user/org.couchdb.user:<name>` and receives an `hnr_` token for
  `_authToken`. Only its SHA-256 is kept, in `tokens.jsonl` beside htpasswd
  (`tokens` to place it elsewhere). `npm logout` revokes it. Signing in never
  creates an account.
- **Audit**: `npm audit`'s bulk advisory request is forwarded to the uplink
  with the Group's names taken out; the uplink has no advisories for them, and
  the Group's dependency inventory is not the uplink's to read.
- **Search**: `GET /-/v1/search` over the Group packages (`scope:` and
  `keywords:` qualifiers; a name match ranks above a description match).

## Publication

The npm client publishes a manifest and attached bytes. For scoped packages npm
may name the attachment `@scope/name-version.tgz`; the registry admits either
wire name and records the canonical `name-version.tgz`. Before writing, it
validates the complete publication: exact package and version identities, one
artifact per version, its canonical filename, canonical base64 and declared
length, supplied SHA-1/SHA-512 digests, a declared repository, and each tag's
version target. Unbound attachments, missing artifacts, conflicting bytes, and
occupied versions are refused, and nothing is written. npm provenance-bundle
attachments are not supported; Group publication uses `--provenance=false`.

A publication then places each tarball in the blob store, links its leaf,
appends its facts (publication, tags, and the readme the tarball ships when it
is latest's), and rewrites the earlier-layout projection. A failure before the
append leaves at most an unadvertised complete artifact; retry can reuse those
exact bytes, but cannot replace them. A journal line cut short by an
interrupted append is not read, and is cut back before the next append.

## Publish gate

A new version is read before it is stored. The registry opens its tarball in
memory (gzip, ustar, PAX; bounded inflation; no link or device members) and
reads it; it never extracts to disk and never runs anything from it. A 400 names
every problem at once, per version, and nothing is stored. The checks, by the
kind each violation reports:

- `export-target`, `bin-target`: an `exports` target (under `import`, `require`,
  `node`, `module-sync`, `default`, or none) or a `bin` target that the tarball does
  not contain. A pattern target must match at least one shipped file.
- `undeclared-import`: a `.mjs`/`.cjs`/`.js` module (outside `node_modules`) with a
  static `import`, `export … from` or `import("literal")` of a house-scoped
  specifier whose package is not in dependencies, peerDependencies or
  optionalDependencies. The package's own name is judged by its own `exports`
  (`self-import`). Modules are read with the Group JavaScript parser
  (`@red-cup-engineering/javascript-parser-service`), so comments and strings are not
  imports; a module that names a Group scope but does not parse is a `source` violation.
- `dependency`: a declared Group dependency with no published version satisfying
  its range (npm semver; a dist-tag also resolves), or a specifier a registry
  cannot resolve (`workspace:`, `file:`, …).
- `dependency-subpath`: an import whose subpath the highest published version
  satisfying the range does not export, `*` patterns and `./package.json` included.
  The message lists the subpaths it does export and any versions that export the
  one imported. A dependency with no `exports` exposes all its files and is not judged.
- `tarball`: bytes that are not an npm tarball, no readable package.json, or a
  package.json naming another package or version.

Group scopes default to `@red-cup-engineering`, `@lenticule-science`, `@561-group`,
`@coesite-operations`, `@causeway-services`, `@emsenn` and the registry's
`privateScopes`; configure `houseScopes` to change them, `publishGate: false` to
turn the gate off. Imports of other packages, `node:` builtins and relative paths
are not checked, and `require()` is not read.

## Metadata updates

A published version is fixed: tarball, integrity and manifest. What moves is
facts about versions, all of it authenticated:

- `npm deprecate` GETs the packument and PUTs it back whole, with no attachments.
  A PUT without attachments is accepted only if every published version is present
  and identical to the served one except for `deprecated` (an empty message clears
  it), and `dist-tags` and `maintainers` are unchanged; anything else is a 409
  naming what differs. A version that would be new needs its tarball (400).
- Dist-tags: GET `/-/package/<name>/dist-tags[/<tag>]`, PUT a version string to
  `.../dist-tags/<tag>`, DELETE `.../dist-tags/<tag>`, on Group packages only. A
  tag must name a published version and must not be a valid semver range;
  `latest` is moved, not removed.
- `npm unpublish` (PUT `/-rev/`, DELETE) is a 405: versions are never removed.
- `npm owner` is a 409: maintainers are the publishers of record.

## Memory is bounded by admission

The registry runs in a small host, and its heap aborted twice on 2026-10-18 (V8
heap exhaustion) under landing publications. It bounds what it holds by
refusing, not by hoping: one publish body is in memory at a time (publishes are
taken in turn); a body over `maxPublishBytes` (64 MiB) is refused 413 and never
read past the cap; a stored tarball is streamed from disk with its length
instead of held; an uplink tarball over `maxUplinkTarballBytes` is not fetched
into memory; and while the V8 heap is within a fifth of its limit a new publish
is answered 503 with Retry-After instead of growing the heap until the process
aborts. Public metadata and Group projections each stay in a 32 MiB
least-recently-used budget (`publicMetadataBytes`, `houseMetadataBytes`).

## Receiving

`npm test` runs every test; `receivingTests` ships the enrolled set with the
package. They cover:

- **Transactions**: complete-transaction refusal, occupied-byte and version
  immutability, concurrent publications, and failed-write preservation.
- **Facts**: the facts and blobs a publication writes, the projections served
  from them, and reception of the earlier layout (including a refused packument
  and a version an earlier release published after a rollback).
- **Store integrity**: cut-short appends, contradictions, two registries
  sharing a store, and a stale lock.
- **Protocol**: revalidation and cache headers, the full document's
  npm-derived fields, sign-in tokens and htpasswd reload, audit filtering, and
  the hosted-application contract.
- **Real clients**: the installed npm client publishes, installs, deprecates,
  tags, signs in at a terminal, logs out, and is refused unpublish and
  republication. The installed pnpm client publishes and installs, and its
  cached metadata is revalidated with a 304.

The publish-gate tests cover each violation kind against real tarballs built
in the tests, and (outside the enrolled set, because they carry fixtures) the
real published tarballs of semiotic-eavt-services-section 0.1.4 and 0.1.5 and
kalshi-services-section 0.1.31. The packed-package regression installs the
actual package tarball, with its installed dependency closure, into an empty
offline consumer, and checks the shipped receiving tests and the
`registry-uplink-prune` script. Fixtures, credentials, and consumers are
disposable local data; no test publishes to an external registry.

A source test pass is not live receiving. The installed service must separately
demonstrate the same protocol and artifact/consumer conditions through the
authorized release route before a deployment change can be claimed.
