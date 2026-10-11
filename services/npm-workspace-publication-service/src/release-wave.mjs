const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const CORE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DEVELOPMENT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([A-Za-z][0-9A-Za-z-]*)\.(0|[1-9]\d*)$/u;

export function classifyReleaseVersion(version) {
  let match = CORE_SEMVER.exec(version);
  if (match) return Object.freeze({ version, kind: "stable", base: version, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), channel: "latest", sequence: null });
  match = DEVELOPMENT_SEMVER.exec(version);
  if (!match) throw new Error(`version must be stable X.Y.Z or development X.Y.Z-tag.N: ${version}`);
  return Object.freeze({
    version, kind: "prerelease", base: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    channel: match[4], sequence: Number(match[5]),
  });
}

export function incrementReleaseBase(version, bump = "patch") {
  const parsed = classifyReleaseVersion(version);
  if (!["major", "minor", "patch"].includes(bump)) throw new Error(`release bump must be major, minor, or patch: ${bump}`);
  // The house is deliberately pre-1.0. A breaking release advances the
  // minor coordinate under SemVer's 0.x rules; no routine command may cross
  // that boundary by accident.
  if (bump === "major") return parsed.major === 0 ? `0.${parsed.minor + 1}.0` : `${parsed.major + 1}.0.0`;
  if (bump === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/**
 * Decide whether a declared release bump can carry the classified change.
 * SemVer treats 0.x minor releases as the breaking boundary; after 1.0 that
 * boundary is major.  House publication policy may impose stricter limits
 * separately through `assertHousePublicationVersion`.
 */
export function releaseBumpAllowsChange(version, bump, change) {
  const parsed = classifyReleaseVersion(version);
  if (change !== "breaking") return bump === "patch" || bump === "minor" || bump === "major";
  return parsed.major === 0 ? bump === "minor" : bump === "major";
}

export function publicationTagForVersion(version, requestedTag) {
  const parsed = classifyReleaseVersion(version);
  if (parsed.kind === "stable") {
    if (requestedTag !== undefined && requestedTag !== "latest") throw new Error(`stable ${version} must publish with npm tag latest`);
    return "latest";
  }
  if (requestedTag === undefined) throw new Error(`development ${version} requires explicit --tag ${parsed.channel}`);
  if (requestedTag !== parsed.channel) throw new Error(`development ${version} must publish with npm tag ${parsed.channel}, not ${requestedTag}`);
  return parsed.channel;
}

const HOUSE_SCOPES = new Set(["@561-group", "@causeway-services", "@coesite-operations", "@emsenn", "@emsweb", "@harmonious-union", "@koios-news", "@lenticule-science", "@red-cup-engineering", "@red-cup-science", "@rsc-quiescent", "@turntide-islands", "@union-officer-academy"]);

/** Refuse the house's accidental stable-1.0 boundary without regulating upstream npm packages. */
export function assertHousePublicationVersion(name, version) {
  const scope = typeof name === "string" && name.startsWith("@") ? name.slice(0, name.indexOf("/")) : null;
  if (HOUSE_SCOPES.has(scope) && classifyReleaseVersion(version).major >= 1) throw new Error(`house publication version must remain below 1.0.0: ${name}@${version}`);
}

export function nextPrereleaseVersion(version, channel, occupied = new Set(), bump = "patch") {
  if (!/^[A-Za-z][0-9A-Za-z-]*$/u.test(channel ?? "")) throw new Error(`development channel must be one nonnumeric SemVer identifier: ${channel}`);
  const parsed = classifyReleaseVersion(version);
  if (parsed.kind === "prerelease" && !occupied.has(version) && parsed.channel === channel) return version;
  const base = parsed.kind === "stable" ? nextUnoccupiedReleaseBase(parsed.base, occupied, bump) : parsed.base;
  let sequence = 0;
  for (const candidate of occupied) {
    const match = DEVELOPMENT_SEMVER.exec(candidate);
    if (match && `${match[1]}.${match[2]}.${match[3]}` === base && match[4] === channel) sequence = Math.max(sequence, Number(match[5]) + 1);
  }
  return `${base}-${channel}.${sequence}`;
}

function nextUnoccupiedReleaseBase(version, occupied, bump) {
  let candidate = incrementReleaseBase(version, bump);
  while (occupied.has(candidate)) candidate = incrementReleaseBase(candidate, bump);
  return candidate;
}

export function nextPatchVersion(version, occupied = new Set()) {
  const parsed = classifyReleaseVersion(version);
  if (parsed.kind !== "stable") throw new Error(`cannot patch-bump non-core semver: ${version}`);
  let candidate = incrementReleaseBase(version, "patch");
  while (occupied.has(candidate)) candidate = incrementReleaseBase(candidate, "patch");
  return candidate;
}

export function nextStableVersion(version, occupied = new Set(), bump = "patch") {
  const parsed = classifyReleaseVersion(version);
  if (parsed.kind !== "stable") throw new Error(`cannot bump non-stable version: ${version}`);
  let candidate = incrementReleaseBase(version, bump);
  while (occupied.has(candidate)) candidate = incrementReleaseBase(candidate, bump);
  return candidate;
}
/** Compute the fixed point of an immutable-registry release. */
export function planReleaseWave(packages, changedNames, occupiedByName, { releaseKind = "stable", channel: requestedChannel, bump = "patch", promotionAdmissions = new Map() } = {}) {
  if (!["stable", "prerelease"].includes(releaseKind)) throw new Error(`release kind must be stable or prerelease: ${releaseKind}`);
  const channel = releaseKind === "prerelease" ? requestedChannel ?? "dev" : requestedChannel;
  if (releaseKind === "stable" && channel !== undefined) throw new Error("stable waves do not take a development channel");
  const byName = new Map();
  for (const entry of packages) {
    if (byName.has(entry.name)) throw new Error(`active package identity is duplicated: ${entry.name}`);
    byName.set(entry.name, entry);
  }

  const targets = new Map();
  const changed = new Set(changedNames);
  const assignTarget = (name) => {
    if (targets.has(name)) return;
    const entry = byName.get(name);
    if (!entry || entry.private) return;
    const occupied = occupiedByName.get(name) ?? new Set();
    let target;
    if (releaseKind === "prerelease") target = nextPrereleaseVersion(entry.version, channel, occupied, bump);
    else {
      const parsed = classifyReleaseVersion(entry.version);
      if (parsed.kind === "prerelease") {
        if (!occupied.has(entry.version)) throw new Error(`cannot promote ${entry.name}@${entry.version}: exact prerelease is absent from the authoritative registry`);
        if (occupied.has(parsed.base)) throw new Error(`cannot promote ${entry.name}@${entry.version}: stable target ${parsed.base} is already occupied`);
        const admission = promotionAdmissions.get(entry.name);
        if (admission?.prerelease !== entry.version || admission?.outcome !== "carrier-verified" || typeof admission?.receipt !== "string" || admission.receipt === "") {
          throw new Error(`cannot promote ${entry.name}@${entry.version}: matching carrier-verified promotion admission is required`);
        }
        target = parsed.base;
      } else target = occupied.has(entry.version) ? nextStableVersion(entry.version, occupied, bump) : entry.version;
    }
    targets.set(name, target);
  };
  for (const name of changed) assignTarget(name);

  const edits = new Map();
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const entry of packages) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const [dependency, specification] of Object.entries(entry.manifest[field] ?? {})) {
          const target = targets.get(dependency);
          if (target === undefined || target === specification) continue;
          const key = `${entry.name}\u0000${field}\u0000${dependency}`;
          if (edits.has(key)) continue;
          edits.set(key, Object.freeze({ consumer: entry.name, field, dependency, from: specification, to: target }));
          changed.add(entry.name);
          const before = targets.size;
          assignTarget(entry.name);
          if (targets.size !== before) advanced = true;
        }
      }
    }
  }

  return Object.freeze({
    releaseKind,
    channel: releaseKind === "prerelease" ? channel : "latest",
    bump,
    targets: Object.freeze([...targets].map(([name, version]) => Object.freeze({
      name,
      from: byName.get(name).version,
      to: version,
      bumped: byName.get(name).version !== version,
    }))),
    dependencyEdits: Object.freeze([...edits.values()]),
    changedNames: Object.freeze([...changed].sort()),
  });
}
