#!/usr/bin/env node
// Deprecated compatibility name. This facade previously started its own
// listener defaulting to 127.0.0.1:4873 — the same address the deployed
// Verdaccio registry (verdaccio.service) already binds — so running it
// alongside Verdaccio either failed to bind or, worse, misled an operator
// into thinking they had started "the" registry. It no longer starts a
// server at all: use serve-npm-registry-read (npm-registry-read-service) to
// deploy the read-only HTTP face of an already-built registry, or rely on
// the deployed Verdaccio instance for day-to-day package hosting.
process.stderr.write("serve-npm-registry is deprecated and starts no server; use serve-npm-registry-read (npm-registry-read-service) or the deployed Verdaccio instance.\n");
process.exitCode = 1;
