import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

// The ledger is append-only: quarantining a defect never touches the
// registry storage, the index, or any line already written here. A defect
// that stops reproducing simply stops being re-appended; nothing is deleted
// to reflect that, so the ledger stays a durable record of every custody
// break this assay has ever observed, not just the currently-open ones.
export async function readQuarantineLedger(ledgerPath) {
  let text;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export async function quarantineRegistryCustodyDefects({ defects, ledgerPath, quarantinedAt }) {
  if (!Array.isArray(defects)) throw new TypeError("`defects` must be an array");
  if (typeof ledgerPath !== "string" || ledgerPath === "") throw new TypeError("`ledgerPath` must be a non-empty string");
  const stamp = quarantinedAt ?? new Date().toISOString();

  const known = new Set((await readQuarantineLedger(ledgerPath)).map((entry) => entry.id));
  const fresh = defects.filter((defect) => !known.has(defect.id));

  if (fresh.length > 0) {
    await mkdir(dirname(ledgerPath), { recursive: true });
    const lines = fresh.map((defect) => JSON.stringify({ ...defect, quarantinedAt: stamp }));
    await appendFile(ledgerPath, `${lines.map((line) => `${line}\n`).join("")}`, "utf8");
  }

  return Object.freeze({
    appended: Object.freeze(fresh.map((defect) => defect.id)),
    alreadyQuarantined: Object.freeze(defects.filter((defect) => known.has(defect.id)).map((defect) => defect.id)),
    total: defects.length,
  });
}
