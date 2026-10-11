import { basename } from "node:path";

const EXCLUDED = new Set(["node_modules", ".git", "dist", "package-lock.json", ".npmrc"]);

export function verificationCopyFilter(path) {
  return !EXCLUDED.has(basename(path));
}
