#!/usr/bin/env node

const registry = new URL(process.env.VERDACCIO_REGISTRY ?? "http://127.0.0.1:4873/");
const ping = new URL("/-/ping", registry);
const response = await fetch(ping, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
if (!response.ok) throw new Error(`Verdaccio ping failed with HTTP ${response.status}`);
process.stdout.write(`${JSON.stringify({ registry: registry.href, status: "available", observedAt: new Date().toISOString() })}\n`);
