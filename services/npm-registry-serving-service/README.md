# House npm registry serving

This private runtime package owns the HTTP npm protocol and the retained house
package store. It runs as the existing standalone registry service or as a
MetroPlat application. The same manifest projection answers packuments, exact
versions, and version selectors through dist-tags; all advertise one canonical
tarball URL on the configured origin.

## Metadata receiving

Root package GET/HEAD routes negotiate npm's
`application/vnd.npm.install-v1+json` representation when explicitly requested
with at least the preference of ordinary JSON. They return `Vary: Accept`;
an absent Accept header or a wildcard-only request retains the full document.
Unsupported media parameters do not match these parameterless representations;
quoted parameter syntax conservatively retains full JSON.
The abbreviated projection includes the recorded package modification time,
installation dependencies and platform constraints, lifecycle-script presence,
and the complete dist object, including integrity, signatures and attestations.
Unknown timestamps and shrinkwrap status are not invented.

The uplink is still fetched as full JSON and stored in full. Abbreviation
does not rewrite history, release times or manifests. Full metadata and
exact-version/tag selectors remain available for consumers needing those
contracts. Concurrent public reads for one name share their in-flight
read/refresh, parse and cache commit across representations and selectors.
Settled work is discarded on success or failure; existing freshness and
stale-on-uplink-error behavior remains. Private names stay local, and client
authorization is never forwarded to the public uplink. This is process-local
in-flight sharing, not a new persistent cache or cross-process coordinator.

Protocol reference:
https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md

## Publication and storage contract

The npm client publishes a package manifest and attached bytes. For scoped
packages npm may name the attachment `@scope/name-version.tgz`; the retained
Verdaccio-compatible store names it `name-version.tgz` beneath the package
directory. This serving boundary admits either wire representation and saves
only the canonical leaf identity. Clients do not repair or rewrite the store.
Packument and dist-tag routes share the same bounded package-name admission;
decoded tag subjects cannot name paths outside a package's store directory.

Before writing, the server validates the complete publication: exact package
and version identities, one artifact per version, its advertised canonical
filename, canonical base64 and declared length, supplied SHA-1/SHA-512 digests,
and each tag's version target. Both digest forms are stored after measurement.
Unbound attachments, missing artifacts, conflicting bytes, and occupied
versions are refused. npm provenance-bundle attachments are not supported;
the existing house publication command uses `--provenance=false`.

One serving process owns a storage directory. Its per-package queue serializes
publications and tag updates. Complete artifact files are admitted without
replacement, then the packument is atomically replaced only after all its new
artifacts exist. A failure can leave an unadvertised complete artifact; retry
can reuse those exact bytes, but cannot replace them. An already published
version is always refused. Operators must not run a second writer against the
same store. This is not a cross-process transaction service or a power-loss
durability guarantee.

The existing authentication, private-name selection, public uplink policy,
on-disk data location, and service entrypoint remain unchanged. This repair
does not migrate live data, republish old identities, or prove which source a
running host has loaded. Publisher-side packing/build/consumer checks remain
responsible for whether the artifact's contents implement its declared API.

## Receiving

`npm test` runs the declared receiving file. It checks complete-transaction
refusal, occupied-byte and version immutability, concurrent publications,
failed-write preservation, retained leaf storage, and public uplink reads.
In-process metadata cases exercise Accept preferences, full-history and dist
preservation, private-name boundaries, shared refreshes and failure recovery.
Two tests start the real standalone entrypoint and use the installed npm
client to publish scoped and unscoped fixture packages, verify advertised
artifact digests, install into empty consumers, and import their shipped API.
The fixture store, credentials, and consumers are disposable local test data;
the tests never publish to an external registry.

A source test pass is not live receiving. The installed service must separately
demonstrate the same package protocol and artifact/consumer conditions through
the authorized release route before registry recovery can be claimed.
