# package-installation-check-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Installs packages from an npm registry into a clean temporary directory and checks that everything they ship actually resolves and runs. Use when verifying that published packages really install and import cleanly.

## Quickstart

Inspect the installed package surface and select an exact registry release. See the [runnable example](examples/quickstart.test.mjs)
and [public API](docs/API.md).

Run `npm ci`, then `npm test` and `npm run test:consumer`.
