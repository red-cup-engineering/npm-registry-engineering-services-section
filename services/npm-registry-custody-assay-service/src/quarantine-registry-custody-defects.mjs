import { each, put } from "@red-cup-engineering/semiotic-eavt-engineering-services-section/store";
import { nowInstantText } from "@red-cup-engineering/time-data-engine";

// Quarantining is an event, `quarantined`, one row-set per defect in the one store
// (`data/records/registry-custody-defect-records/records.jsonl` under `dataRoot`).
// It never touches the registry storage or the index, and a row is never changed or removed:
// a defect that stops reproducing simply stops being re-recorded, so the file stays a record of
// every ownership break this assay has ever observed.
const KIND = "registry-custody-defect";

/** Every quarantined defect, oldest first: `{event, time, subject, status, ...defect}`. */
export function readQuarantine(dataRoot) {
  return [...each(dataRoot, KIND)].map(({ record }) => record);
}

export function quarantineRegistryCustodyDefects({ defects, dataRoot, quarantinedAt }) {
  if (!Array.isArray(defects)) throw new TypeError("`defects` must be an array");
  if (typeof dataRoot !== "string" || dataRoot === "") throw new TypeError("`dataRoot` must be a non-empty string");
  const time = quarantinedAt ?? nowInstantText();
  const known = new Set(readQuarantine(dataRoot).map((row) => row.subject));
  const fresh = defects.filter((defect) => !known.has(defect.id));
  for (const defect of fresh) {
    const { id, ...fields } = defect;
    put(dataRoot, KIND, { event: "quarantined", time, subject: id, status: "quarantined", ...fields });
  }
  return Object.freeze({
    appended: Object.freeze(fresh.map((defect) => defect.id)),
    alreadyQuarantined: Object.freeze(defects.filter((defect) => known.has(defect.id)).map((defect) => defect.id)),
    total: defects.length,
  });
}
