const SPEC_SUMMARY = { tests: /^ℹ tests (\d+)$/mu, pass: /^ℹ pass (\d+)$/mu, fail: /^ℹ fail (\d+)$/mu };
const TAP_SUMMARY = { tests: /^# tests (\d+)$/mu, pass: /^# pass (\d+)$/mu, fail: /^# fail (\d+)$/mu };

/**
 * Parse the {tests, pass, fail} counts Node's built-in test runner prints in
 * its summary lines, under either the default `spec` reporter (`ℹ tests N`)
 * or the `tap` reporter (`# tests N`).
 * @param {string} output Combined stdout (and, defensively, stderr) of a `node --test` run.
 * @returns {{tests: number, pass: number, fail: number}} The parsed summary counts.
 * @throws {Error} When neither reporter's summary lines are present in output.
 */
export function parseTestRunSummary(output) {
  const text = typeof output === "string" ? output : "";
  for (const patterns of [SPEC_SUMMARY, TAP_SUMMARY]) {
    const tests = patterns.tests.exec(text);
    const pass = patterns.pass.exec(text);
    const fail = patterns.fail.exec(text);
    if (tests && pass && fail) {
      return Object.freeze({ tests: Number(tests[1]), pass: Number(pass[1]), fail: Number(fail[1]) });
    }
  }
  throw new Error("node --test output did not carry a recognizable summary (spec `ℹ tests/pass/fail` or tap `# tests/pass/fail`)");
}
