function normalizeRegistry(registry) {
  return registry.endsWith("/") ? registry : `${registry}/`;
}

function commandFailure(error) {
  return [error?.stdout, error?.stderr, error?.message].map((part) => String(part ?? "").trim()).filter(Boolean).join(" | ");
}

/**
 * Verify a registry is actually reachable and authenticated before any
 * install, test, or publish step depends on it: an HTTP GET (expect 200),
 * `npm ping`, `npm whoami` (confirms auth, not just reachability), and that
 * the package's scope is actually routed at this registry in the running
 * npm configuration. Stops at the first failing check; every check already
 * run is still reported as evidence.
 * @param {object} input
 * @param {string} input.registry The canonical registry base URL to verify.
 * @param {string} [input.scope] The package's npm scope (e.g. "@red-cup-engineering"), checked for correct routing when given.
 * @param {(url: string, init?: object) => Promise<Response>} [input.fetchImpl] Injectable HTTP transport.
 * @param {(command: string, args: readonly string[], options?: object) => Promise<{stdout: string, stderr: string}>} [input.execFileImpl] Injectable process runner (promisified `child_process.execFile` shape).
 * @returns {Promise<{ok: boolean, reason: string|null, evidence: object}>}
 */
export async function checkRegistryLiveness({ registry, scope, fetchImpl = fetch, execFileImpl }) {
  if (typeof registry !== "string" || registry === "") throw new TypeError("registry is required");
  if (typeof execFileImpl !== "function") throw new TypeError("execFileImpl is required");
  const evidence = {};
  try {
    const response = await fetchImpl(registry, { signal: AbortSignal.timeout(10_000) });
    evidence.httpStatus = response.status;
    if (response.status !== 200) return Object.freeze({ ok: false, reason: `registry GET ${registry} returned ${response.status}, expected 200`, evidence: Object.freeze(evidence) });
  } catch (error) {
    evidence.httpError = String(error?.message ?? error);
    return Object.freeze({ ok: false, reason: `registry GET ${registry} failed: ${evidence.httpError}`, evidence: Object.freeze(evidence) });
  }
  try {
    const ping = await execFileImpl("npm", ["ping", "--registry", registry]);
    evidence.npmPing = `${ping.stdout}${ping.stderr}`.trim();
  } catch (error) {
    evidence.npmPingError = commandFailure(error);
    return Object.freeze({ ok: false, reason: `npm ping --registry ${registry} failed: ${evidence.npmPingError}`, evidence: Object.freeze(evidence) });
  }
  try {
    const whoami = await execFileImpl("npm", ["whoami", "--registry", registry]);
    evidence.npmWhoami = whoami.stdout.trim();
  } catch (error) {
    evidence.npmWhoamiError = commandFailure(error);
    return Object.freeze({ ok: false, reason: `npm whoami --registry ${registry} failed: ${evidence.npmWhoamiError}`, evidence: Object.freeze(evidence) });
  }
  if (scope) {
    try {
      const configured = await execFileImpl("npm", ["config", "get", `${scope}:registry`]);
      evidence.scopeRegistry = configured.stdout.trim();
      if (normalizeRegistry(evidence.scopeRegistry) !== normalizeRegistry(registry)) {
        return Object.freeze({ ok: false, reason: `npm scope ${scope} routes to ${evidence.scopeRegistry}, expected ${registry}`, evidence: Object.freeze(evidence) });
      }
    } catch (error) {
      evidence.scopeRegistryError = commandFailure(error);
      return Object.freeze({ ok: false, reason: `npm config get ${scope}:registry failed: ${evidence.scopeRegistryError}`, evidence: Object.freeze(evidence) });
    }
  }
  return Object.freeze({ ok: true, reason: null, evidence: Object.freeze(evidence) });
}
