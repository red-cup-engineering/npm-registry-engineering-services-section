# npm registry snapshot publication service

Builds a named immutable registry snapshot in `HOST/snapshots/NAME`, verifies
it through the coordinator, then atomically advances `HOST/current` through
the snapshot-activation service. It never stops a server, swaps active
directories, polls HTTP, or generates graphs.

`publish-npm-registry-snapshot --package DIR --host HOST --snapshot NAME --registry-url URL [--base-snapshot NAME]`

This is a releasable CLI, not a deployable application: it performs one bounded
publication operation and exits; a separate read app owns the long-running HTTP face.
