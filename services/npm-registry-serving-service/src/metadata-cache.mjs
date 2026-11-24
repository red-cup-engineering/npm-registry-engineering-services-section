/** Rebuildable metadata retention, weighted by its serialized UTF-8 material.
 * In-flight readers may retain an evicted value until their response finishes. */
export function boundedMetadata(limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("metadata cache budget must be a non-negative safe integer");
  const entries = new Map();
  let held = 0;
  const forget = key => {
    const entry = entries.get(key);
    if (entry) { held -= entry.bytes; entries.delete(key); }
  };
  const trim = () => {
    for (const key of entries.keys()) { if (held <= limit) break; forget(key); }
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key); entries.set(key, entry);
      return entry.value;
    },
    set(key, value, bytes) {
      forget(key);
      if (limit === 0 || bytes > limit) return;
      entries.set(key, {value, bytes}); held += bytes; trim();
    },
    weigh(key, bytes) {
      const entry = entries.get(key);
      if (entry) { entry.bytes += bytes; held += bytes; if (entry.bytes > limit) forget(key); else trim(); }
    },
    forget,
    clear() { entries.clear(); held = 0; },
  };
}
