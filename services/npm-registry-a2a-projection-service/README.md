# npm-registry-a2a-projection-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Translation only, no server. Given a registry root and URL, `obtainRegistrySnapshot` (`src/snapshot.mjs`) reads that registry's receipt and metadata and returns the current snapshot as plain data. `registrySnapshotProtocol` (`src/protocol.mjs`) declares the A2A request/response message shapes for asking for that snapshot. `scripts/execute-a2a-task.mjs` decodes one incoming A2A message, calls the snapshot function, and encodes the response — it reads `REGISTRY_ROOT` and `REGISTRY_URL` and refuses to guess at either.

Nothing here opens a port or starts listening. If you actually want to serve a registry over A2A, compose this package's `execute-a2a-task.mjs` as the executor for `@red-cup-engineering/a2a-contracted-agent-service`'s `serveContractedAgent` — that's the piece that runs a web server. `content/agent-card.template.json` is a starting point for the Agent Card such a server would publish; it has no real URL in it because this package doesn't know where, or whether, anyone deploys one.
