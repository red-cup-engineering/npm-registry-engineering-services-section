/**
 * The last `count` lines of text (fewer if it has fewer lines), for putting
 * a bounded amount of raw command output into refusal evidence.
 * @param {string} text Arbitrary multi-line text.
 * @param {number} count A non-negative maximum number of trailing lines.
 * @returns {string} The trailing lines, newline-joined; "" for empty input.
 * @throws {TypeError} When text is not a string or count is not a non-negative integer.
 */
export function lastLines(text, count) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  if (!Number.isInteger(count) || count < 0) throw new TypeError("count must be a non-negative integer");
  if (text === "" || count === 0) return "";
  return text.split("\n").slice(-count).join("\n");
}
