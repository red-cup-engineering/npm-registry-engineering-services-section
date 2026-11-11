#!/usr/bin/env node
process.stderr.write("build-npm-registry is deprecated; use publish-npm-registry-snapshot with --host and --snapshot.\n");
process.exitCode = 1;
