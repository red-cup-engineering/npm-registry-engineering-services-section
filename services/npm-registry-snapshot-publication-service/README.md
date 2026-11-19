# npm registry snapshot publication service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Builds a named immutable registry snapshot in `HOST/snapshots/NAME`, verifies
it through the coordinator, then atomically advances `HOST/current` through
the snapshot-activation service. It never stops a server, swaps active
directories, polls HTTP, or generates graphs.

`publish-npm-registry-snapshot --package DIR --host HOST --snapshot NAME --registry-url URL [--base-snapshot NAME]`

This is a releasable CLI, not a deployable application: it performs one bounded
publication operation and exits; a separate read app owns the long-running HTTP face.
