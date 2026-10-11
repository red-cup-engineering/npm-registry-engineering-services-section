import {
  dependencySpecificationViolations,
  packageLockDirectResolutionViolations,
  packageLockRootDependencyViolations,
  packageLockRootIdentityViolations,
} from "./dependency-policy.mjs";
import { classifyLockfileResolvedUrls } from "./lockfile-registry-classification.mjs";

export const CANONICAL_PUBLICATION_REGISTRY = "https://registry.561.group";
export const PUBLICATION_PLAN_MEDIA_TYPE = "application/vnd.red-cup-engineering.npm-workspace-publication-plan+json";
const RESOURCE_KIND = "npm-workspace-publication-plan@1";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function packageRelativePath(value) {
  const path = requireText(value, "package.path");
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new TypeError("package locator must be a canonical repository-relative path");
  }
  return path;
}

/**
 * Resolve the plan Resource only from the current host-supplied signed Action.
 * This does not grant an effect: it refuses if the exact allocated execution
 * Action does not carry one unique witnessed plan Resource for this scope.
 */
export function publicationPlanResourceOf(item) {
  const action = item?.signedAction;
  if (!object(action) || action.operation !== "agency-work-execute") {
    throw new TypeError("publication planning requires the current signed agency-work-execute Action");
  }
  if (typeof item.scope !== "string" || item.scope.trim() === "") throw new TypeError("publication planning requires the exact allocated scope");
  const matches = (Array.isArray(action.resources) ? action.resources : []).filter((entry) =>
    object(entry) && object(entry.resource) && entry.resource.kind === RESOURCE_KIND);
  if (matches.length !== 1) throw new TypeError("the signed Action must carry exactly one publication-plan Resource");
  const [entry] = matches;
  if (typeof entry.id !== "string" || entry.id === "" || typeof entry.witness !== "string" || entry.witness === "" || !object(entry.evidence)) {
    throw new TypeError("the signed publication-plan Resource must retain its canonical witness and evidence");
  }
  if (entry.resource.scope !== item.scope) throw new TypeError("publication-plan Resource scope does not match the allocated Action scope");
  return Object.freeze({ id: entry.id, witness: entry.witness, evidence: entry.evidence, resource: entry.resource });
}

/**
 * Inspect only the immutable package manifest and lockfile bytes supplied by
 * the host after it resolves the signed allocation Resource and accepted Git
 * commit. This is not the publication gate: it does not invoke npm, lifecycle
 * scripts, a registry, an install, a build, tests, pack, or a receipt writer.
 */
export function readOnlyPublicationPlan({ resource, acceptedSource, manifestText, lockText }) {
  if (!object(resource) || resource.kind !== RESOURCE_KIND || resource.effect !== "read-only-plan") {
    throw new TypeError("a signed npm-workspace-publication-plan@1 Resource is required");
  }
  if (resource.registry !== CANONICAL_PUBLICATION_REGISTRY) {
    throw new TypeError("publication plan Resource must name the fixed canonical registry");
  }
  requireText(resource.title, "resource.title");
  requireText(resource.description, "resource.description");
  requireText(resource.locator, "resource.locator");
  if (resource.mediaType !== PUBLICATION_PLAN_MEDIA_TYPE) throw new TypeError("publication plan Resource has an unsupported media type");
  if (!object(resource.source)) throw new TypeError("publication plan Resource must bind an accepted source identity");
  const source = Object.freeze({
    repository: requireText(resource.source.repository, "source.repository"),
    duty: requireText(resource.source.duty, "source.duty"),
    subject: requireText(resource.source.subject, "source.subject"),
    commit: requireText(resource.source.commit, "source.commit"),
    tree: requireText(resource.source.tree, "source.tree"),
    receiving: requireText(resource.source.receiving, "source.receiving"),
  });
  if (!/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(source.receiving)) {
    throw new TypeError("source.receiving must be the canonical content address of its independent receiving record");
  }
  if (!object(acceptedSource)
    || acceptedSource.repository !== source.repository
    || acceptedSource.duty !== source.duty
    || acceptedSource.subject !== source.subject
    || acceptedSource.commit !== source.commit
    || acceptedSource.tree !== source.tree
    || acceptedSource.receiving !== source.receiving) {
    throw new TypeError("plan Resource source does not match the host-verified accepted integrated source");
  }
  if (!object(resource.package)) throw new TypeError("publication plan Resource must bind one package");
  const expectedName = requireText(resource.package.name, "package.name");
  const packagePath = packageRelativePath(resource.package.path);
  if (resource.locator !== packagePath) throw new TypeError("Resource locator must equal the confined package path");
  const manifest = JSON.parse(requireText(manifestText, "immutable package.json content"));
  const lock = JSON.parse(requireText(lockText, "immutable package-lock.json content"));
  if (!object(manifest) || manifest.name !== expectedName) {
    throw new TypeError("package manifest identity does not match the signed plan Resource");
  }

  const checks = Object.freeze({
    manifestDependencies: dependencySpecificationViolations(manifest),
    lockRootDependencies: packageLockRootDependencyViolations(manifest, lock),
    lockRootIdentity: packageLockRootIdentityViolations(manifest, lock),
    directResolutions: packageLockDirectResolutionViolations(manifest, lock),
    houseRegistryResolutions: classifyLockfileResolvedUrls(lock, CANONICAL_PUBLICATION_REGISTRY),
  });
  const localRefusals = Object.entries(checks)
    .filter(([, value]) => Array.isArray(value) ? value.length > 0 : value.houseScopedNotCanonical > 0)
    .map(([check]) => check);

  return Object.freeze({
    kind: "npm-workspace-publication-plan@1",
    effect: "read-only-plan",
    decision: localRefusals.length === 0 ? "local-inputs-consistent" : "local-inputs-refused",
    source,
    package: Object.freeze({ name: manifest.name, version: manifest.version, path: packagePath }),
    registry: CANONICAL_PUBLICATION_REGISTRY,
    checks,
    refusals: Object.freeze(localRefusals),
    remaining: Object.freeze([
      "The host verified these bytes against the independently accepted, integrated Git source bound to the signed allocation Resource.",
      "Registry liveness, installed dependency state, lifecycle/build/test results, package contents, tarball classification, version availability, and publication are not evaluated.",
      "No publication or package mutation is authorized by this result.",
    ]),
    effects: Object.freeze({ filesWritten: false, packageManagerInvoked: false, lifecycleInvoked: false, networkAccessed: false, packageMutated: false, published: false }),
  });
}

/** Host entry point: bind planning to the current allocated Action and its
 * witnessed Resource before reading any package path. */
export function readOnlyPublicationPlanForItem({ item, acceptedSource, manifestText, lockText }) {
  const signed = publicationPlanResourceOf(item);
  const plan = readOnlyPublicationPlan({ resource: signed.resource, acceptedSource, manifestText, lockText });
  return Object.freeze({
    ...plan,
    action: Object.freeze({ id: item.signedAction.id, scope: item.scope, operation: item.signedAction.operation }),
    resourceWitness: Object.freeze({ id: signed.id, witness: signed.witness, evidence: signed.evidence }),
  });
}

export const publicationPlanResourceKind = RESOURCE_KIND;
