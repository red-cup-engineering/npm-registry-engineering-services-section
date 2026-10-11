/**
 * Assemble the publish-or-refusal record body this house's publish gate has
 * recorded through `@red-cup-engineering/eavt-services-section/semantic-record`
 * (field shape verified against `npm-registry-services-section`'s and
 * `news-media-engineering-services-section`'s own prior receipts): package
 * identity, the fresh-install test count, the lockfile classification, and
 * the tarball-diff classification, plus whatever the gate actually did.
 * @param {object} input
 * @param {string} input.package The package name.
 * @param {"publish"|"refusal"|"pin"} input.action
 * @param {string} input.date An ISO calendar date (YYYY-MM-DD).
 * @param {string} input.fromVersion The package's version before this run.
 * @param {string|null} input.toVersion The published (or planned) version, null when no bump occurred.
 * @param {{tests: number, pass: number, fail: number}} input.freshInstallTestCount
 * @param {object} input.freshInstallLockfileCheck The lockfile URL classification for the fresh install.
 * @param {"additive"|"breaking"|"first-publish"} input.tarballDiffClassification
 * @param {object} [input.extra] Additional publish-specific fields (a refusal step/reason, repin outcomes, verify evidence) merged onto the record.
 * @returns {object} A frozen record body ready for `journal.record({record: ...})`.
 * @throws {TypeError} When a required field is missing or the wrong shape.
 */
export function buildPublishGateReceipt({
  package: packageName,
  action,
  date,
  fromVersion,
  toVersion,
  freshInstallTestCount,
  freshInstallLockfileCheck,
  tarballDiffClassification,
  extra = {},
}) {
  if (typeof packageName !== "string" || packageName === "") throw new TypeError("package is required");
  if (action !== "publish" && action !== "refusal" && action !== "pin") throw new TypeError('action must be "publish", "refusal", or "pin"');
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new TypeError("date must be an ISO calendar date");
  if (typeof fromVersion !== "string" || fromVersion === "") throw new TypeError("fromVersion is required");
  if (!freshInstallTestCount || typeof freshInstallTestCount.tests !== "number" || typeof freshInstallTestCount.pass !== "number" || typeof freshInstallTestCount.fail !== "number") {
    throw new TypeError("freshInstallTestCount must carry numeric tests/pass/fail");
  }
  if (!freshInstallLockfileCheck || typeof freshInstallLockfileCheck !== "object") throw new TypeError("freshInstallLockfileCheck is required");
  if (!["additive", "breaking", "first-publish"].includes(tarballDiffClassification)) {
    throw new TypeError('tarballDiffClassification must be "additive", "breaking", or "first-publish"');
  }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new TypeError("extra must be an object");
  return Object.freeze({
    package: packageName,
    action,
    date,
    fromVersion,
    toVersion: toVersion ?? null,
    freshInstallTestCount: Object.freeze({ ...freshInstallTestCount }),
    freshInstallLockfileCheck: Object.freeze({ ...freshInstallLockfileCheck }),
    tarballDiffClassification,
    ...extra,
  });
}
