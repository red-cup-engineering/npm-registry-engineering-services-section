const SPEC_FAILURE = /^[ \t]*✖\s+(.+?)\s+\([\d.]+m?s\)\s*$/gmu;
const TAP_FAILURE = /^not ok \d+ - (.+)$/gmu;

/**
 * List the names of failing tests out of Node's built-in test runner output,
 * under either the default `spec` reporter (`✖ <name> (<duration>)`, which
 * prints once inline where the test ran and again in the trailing "failing
 * tests:" recap) or the `tap` reporter (`not ok <n> - <name>`). Deduplicated,
 * in first-seen order; a fully passing run yields an empty list.
 * @param {string} output Combined stdout (and, defensively, stderr) of a `node --test` run.
 * @returns {readonly string[]} Failing test names.
 */
export function parseFailingTestNames(output) {
  const text = typeof output === "string" ? output : "";
  const seen = new Set();
  const names = [];
  for (const pattern of [SPEC_FAILURE, TAP_FAILURE]) {
    for (const match of text.matchAll(pattern)) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        names.push(match[1]);
      }
    }
  }
  return Object.freeze(names);
}
