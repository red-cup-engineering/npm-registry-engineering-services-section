import { gunzipSync } from "node:zlib";

/**
 * Read an npm tarball (gzip over ustar, with PAX and GNU long-name extensions) entirely in memory, statically:
 * nothing is written to disk and nothing in it is executed. Returns the regular files as a Map of
 * package-relative path (the archive's single top-level directory, `package/` for npm, removed) to bytes.
 *
 * Refuses what a registry has no business accepting: an archive that inflates past `maxBytes`, a member whose
 * path is absolute, contains `..`, or sits outside the one top-level directory, a damaged header, and links or
 * devices (npm never packs them; extraction of a link is how an archive writes outside its own directory).
 */
export class TarballError extends Error {
  constructor(message) { super(message); this.name = "TarballError"; }
}

const text = (bytes) => bytes.toString("utf8").replace(/\0[\s\S]*$/u, "");
function octal(bytes, label) {
  const value = bytes.toString("ascii").replace(/\0[\s\S]*$/u, "").trim();
  if (!/^[0-7]*$/u.test(value)) throw new TarballError(`tarball header has an invalid ${label}`);
  return value === "" ? 0 : Number.parseInt(value, 8);
}
function paxRecords(bytes) {
  const records = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const length = space < 0 ? NaN : Number.parseInt(bytes.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) throw new TarballError("tarball has malformed PAX metadata");
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}
function memberPath(name) {
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (name.startsWith("/") || name.includes("\\") || name.includes("\0") || parts.includes("..") || parts.length === 0) {
    throw new TarballError(`tarball member path is unsafe: ${JSON.stringify(name)}`);
  }
  return parts;
}

export function readTarball(gzipped, { maxBytes = 512 * 1024 * 1024 } = {}) {
  let archive;
  try { archive = gunzipSync(gzipped, { maxOutputLength: maxBytes }); }
  catch (error) {
    throw new TarballError(error.code === "ERR_BUFFER_TOO_LARGE" ? `tarball inflates past ${maxBytes} bytes` : `tarball is not gzip data: ${error.message}`);
  }
  const members = [];
  let offset = 0, pax = {}, longName = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (octal(header.subarray(148, 156), "checksum") !== sum) throw new TarballError("tarball header checksum does not match");
    const size = octal(header.subarray(124, 136), "size");
    const start = offset + 512, end = start + size;
    if (end > archive.length) throw new TarballError("tarball member runs past the end of the archive");
    offset = start + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 0x30);
    const body = archive.subarray(start, end);
    if (type === "x") { pax = { ...pax, ...paxRecords(body) }; continue; }
    if (type === "g") continue;
    if (type === "L") { longName = text(body); continue; }
    const prefix = text(header.subarray(345, 500));
    const name = pax.path ?? longName ?? `${prefix ? `${prefix}/` : ""}${text(header.subarray(0, 100))}`;
    pax = {}; longName = null;
    if (type === "5") continue;
    if (type !== "0") throw new TarballError(`tarball member ${JSON.stringify(name)} is not a regular file or directory`);
    members.push({ parts: memberPath(name), body });
  }
  const roots = new Set(members.map(({ parts }) => parts[0]));
  if (roots.size > 1) throw new TarballError("tarball must have one top-level directory");
  const files = new Map();
  for (const { parts, body } of members) {
    if (parts.length < 2) throw new TarballError("tarball has a file outside its top-level directory");
    files.set(parts.slice(1).join("/"), body);
  }
  return files;
}
