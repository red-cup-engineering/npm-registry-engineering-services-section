/** First-party framing recovered from PR24 a40a8655d656c2ffa8d75d90bdf99f700e1a90c3,
 * src/packed-carrier-archive.mjs blob c044915f3d0431ff9dd16c5239a507c3bccad1b1.
 * Retains its header/PAX/path and sorted-prefix conflict algorithms, evolved
 * for the current strict receiving specification. No filesystem, decompression,
 * extraction or installation effects: the original receiver owns custody.
 */
import { createHash } from 'node:crypto';
const BLOCK = 512;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const isZero = block => block.every(byte => byte === 0);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const codes = { extension: 'unread-archive-extension', encoding: 'unread-archive-name-encoding', accounting: 'unread-archive-header-accounting' };
function refuse(reason, offset, message) {
  return Object.assign(new TypeError(message), { code: codes[reason] ?? 'artifact-member-receiving-refused', reason,
    ...(Number.isSafeInteger(offset) && offset >= 0 ? { offset } : {}) });
}
function text(bytes, offset) {
  let value;
  try { value = utf8.decode(bytes); }
  catch { throw refuse('encoding', offset, 'archive field is not lossless UTF8'); }
  if (!Buffer.from(value).equals(bytes)) throw refuse('encoding', offset, 'archive field changed during decoding');
  return value;
}
function nulTerminated(block, from, length, offset) {
  const field = block.subarray(from, from + length), end = field.indexOf(0);
  if (end >= 0 && !isZero(field.subarray(end))) throw refuse('wire-profile', offset + from, 'archive field has data after NUL');
  return text(end < 0 ? field : field.subarray(0, end), offset + from);
}
function number(block, from, length, key, offset, { blank = false, negative = false, binary = true } = {}) {
  const field = block.subarray(from, from + length);
  let value;
  if (field[0] & 0x80) {
    if (!binary || ![0x80, 0xff].includes(field[0]) || field[0] === 0xff && !negative)
      throw refuse('number', offset + from, 'unsupported binary tar ' + key);
    value = 0n;
    for (const byte of field.subarray(1)) value = value * 256n + BigInt(byte);
    if (field[0] === 0xff) value -= 1n << BigInt((length - 1) * 8);
  } else {
    // Validate bytes, not ASCII-masked Buffer.toString output.
    let begin = 0, end = field.length;
    while (field[begin] === 32) begin++;
    while (end > begin && [0, 32].includes(field[end - 1])) end--;
    if (begin === end) {
      if (blank) return undefined;
      throw refuse('number', offset + from, 'blank tar ' + key);
    }
    value = 0n;
    for (const byte of field.subarray(begin, end)) {
      if (byte < 48 || byte > 55) throw refuse('number', offset + from, 'invalid tar ' + key);
      value = value * 8n + BigInt(byte - 48);
    }
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER) || !negative && value < 0n)
    throw refuse('number', offset + from, 'unsafe tar ' + key);
  return Number(value);
}
function headerFields(block, offset, legacy = false) {
  const expected = number(block, 148, 8, 'checksum', offset, { binary: false });
  let checksum = 0;
  for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : block[i];
  if (checksum !== expected) throw refuse('checksum', offset, 'tar header checksum mismatch');
  const ordinaryMagic = block.subarray(257, 265).equals(Buffer.from('ustar\0' + '00'));
  const oldGNU = legacy && block.subarray(257, 265).equals(Buffer.from('ustar  \0'));
  if ((!ordinaryMagic && !oldGNU) || !isZero(block.subarray(oldGNU ? 345 : 500)))
    throw refuse('wire-profile', offset, 'unsupported tar magic/version/reserved bytes');
  const mode = number(block, 100, 8, 'mode', offset);
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) throw refuse('mode', offset, 'unqualified tar permissions');
  const size = number(block, 124, 12, 'size', offset);
  for (const [from, length, key] of [[108, 8, 'uid'], [116, 8, 'gid'], [329, 8, 'devmajor'], [337, 8, 'devminor']])
    number(block, from, length, key, offset, { blank: true });
  number(block, 136, 12, 'mtime', offset, { blank: true, negative: true });
  let prefix = '', layout = oldGNU ? 'old-gnu-zero-suffix' : 'ustar';
  if (!oldGNU) {
    if (!legacy) prefix = nulTerminated(block, 345, 155, offset);
    else {
      let ordinary, ordinaryError, alternate, alternateError;
      try { ordinary = nulTerminated(block, 345, 155, offset); } catch (error) { ordinaryError = error; }
      const timestamps = !isZero(block.subarray(476, 500));
      if (block[475] === 0 && timestamps) {
        try {
          alternate = nulTerminated(block, 345, 130, offset);
          const atime = number(block, 476, 12, 'node-tar atime', offset, { blank: true, negative: true, binary: false });
          const ctime = number(block, 488, 12, 'node-tar ctime', offset, { blank: true, negative: true, binary: false });
          if (atime === undefined && ctime === undefined) throw refuse('wire-profile', offset, 'numeric node-tar timestamp required');
        } catch (error) { alternateError = error; }
        if (ordinary !== undefined) throw refuse('wire-profile', offset, 'overlapping tar layout interpretations');
        if (alternateError) throw alternateError;
        prefix = alternate; layout = 'node-tar-timestamps';
      } else {
        if (ordinaryError) throw ordinaryError;
        prefix = ordinary;
      }
    }
  }
  const leaf = nulTerminated(block, 0, 100, offset);
  if (prefix.includes('\ufffd') || leaf.includes('\ufffd')) throw refuse('encoding', offset, 'ambiguous raw archive name');
  nulTerminated(block, 265, 32, offset); nulTerminated(block, 297, 32, offset);
  return { layout, size, mode, type: String.fromCharCode(block[156]), name: prefix ? prefix + '/' + leaf : leaf, hasLinkName: !isZero(block.subarray(157, 257)) };
}
function paxRecords(payload, offset, legacy = false) {
  // Validate the complete payload before interpreting record boundaries.
  text(payload, offset);
  const result = Object.create(null);
  for (let at = 0; at < payload.length;) {
    let digitEnd = at;
    while (digitEnd < payload.length && payload[digitEnd] >= 48 && payload[digitEnd] <= 57) digitEnd++;
    if (digitEnd === at || payload[at] === 48 || payload[digitEnd] !== 32 || digitEnd - at > 16)
      throw refuse('extension', offset + at, 'invalid PAX record length');
    const length = Number(payload.toString('ascii', at, digitEnd));
    if (!Number.isSafeInteger(length) || length < digitEnd - at + 4 || length > payload.length - at)
      throw refuse('extension', offset + at, 'invalid PAX record framing');
    const record = payload.subarray(digitEnd + 1, at + length);
    if (record.at(-1) !== 10) throw refuse('extension', offset + at, 'unterminated PAX record');
    const equal = record.indexOf(61), key = text(record.subarray(0, equal < 0 ? 0 : equal), offset + digitEnd + 1);
    if (equal <= 0 || !(legacy ? legacyPaxKey(key) : ['path', 'size', 'mtime', 'atime', 'ctime'].includes(key)) || key in result)
      throw refuse('extension', offset + at, 'unqualified or repeated PAX attribute');
    result[key] = text(record.subarray(equal + 1, -1), offset + digitEnd + equal + 2);
    at += length;
  }
  if (legacy) validateLegacyPax(result, offset);
  if (!result.path || result.path.includes('\0')) throw refuse('extension', offset, 'PAX names no literal member');
  if (result.path.includes('\ufffd')) throw refuse('encoding', offset, 'ambiguous PAX member name');
  if (result.size !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/u.test(result.size) || !Number.isSafeInteger(Number(result.size)))
      throw refuse('extension', offset, 'PAX size is not a safe whole number');
    result.size = Number(result.size);
  }
  return result;
}
const retainedProjections = new WeakMap();
/** Reads original held-byte scanner evidence; cannot register or authenticate external facts. */
export function readRetainedRegistryProjection(sourceArchive, projection) {
  const retained = projection && retainedProjections.get(projection);
  if (!retained || !sourceArchive || typeof sourceArchive !== 'object' || Array.isArray(sourceArchive)) throw refuse('projection', undefined, 'original retained projection required');
  const {integrity, ...source} = sourceArchive;
  if (JSON.stringify(source) !== retained.source || JSON.stringify(projection) !== retained.projection) throw refuse('projection', undefined, 'retained projection evidence mutated');
  return {sourceArchive:JSON.parse(retained.source), projection:JSON.parse(retained.projection)};
}
const profiles = ['npm-gzip-tar-v1', 'npm-registry-legacy-v1', 'npm-registry-legacy-idempotent-files-v1'];
const unsigned = /^(0|[1-9][0-9]*)$/u;
const legacyNumbers = new Set(['uid', 'gid', 'SCHILY.dev', 'SCHILY.ino', 'NODETAR.depth', 'NODETAR.blksize', 'NODETAR.blocks']);
const legacyStrings = new Set(['name', 'version', 'description', 'main', 'author', 'license', 'homepage', 'repository.type', 'repository.url', 'bugs.url', 'scripts.test'].map(x => 'NODETAR.package.' + x));
function legacyPaxKey(key) {
  if (['path','size','mtime','atime','ctime','SCHILY.nlink','NODETAR.follow','NODETAR.type','NODETAR.package.browser.crypto'].includes(key) || legacyNumbers.has(key) || legacyStrings.has(key)) return true;
  if (/^NODETAR\.(?:ignoreFiles|package\.keywords)\.(0|[1-9][0-9]*)$/u.test(key)) return true;
  const dependency = /^NODETAR\.package\.(?:dependencies|devDependencies)\.(.+)$/u.exec(key)?.[1];
  return !!dependency && Buffer.byteLength(dependency) <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(dependency)
    && !dependency.split(/[./]/u).some(x => ['__proto__','prototype','constructor'].includes(x));
}
function validateLegacyPax(records, offset) {
  const families = new Map();
  for (const [key, value] of Object.entries(records)) {
    if (Buffer.byteLength(key) > 256 || Buffer.byteLength(value) > 65536 || /[\x00-\x1f\x7f]/u.test(value)) throw refuse('extension', offset, 'legacy PAX field bound/encoding');
    if ((legacyNumbers.has(key) || key === 'size') && (!unsigned.test(value) || !Number.isSafeInteger(Number(value)))) throw refuse('extension', offset, 'legacy PAX unsigned integer');
    if (['mtime','atime','ctime'].includes(key) && (!/^-?(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/u.test(value) || !Number.isSafeInteger(Number(value.split('.')[0])))) throw refuse('extension', offset, 'legacy PAX timestamp');
    const expected = {'SCHILY.nlink':'1','NODETAR.follow':'false','NODETAR.type':'File','NODETAR.package.browser.crypto':'false'}[key];
    if (expected !== undefined && value !== expected) throw refuse('extension', offset, 'unsupported legacy PAX semantics');
    const indexed = /^(NODETAR\.(?:ignoreFiles|package\.keywords))\.(0|[1-9][0-9]*)$/u.exec(key);
    if (indexed) {
      const index = Number(indexed[2]);
      if (!Number.isSafeInteger(index) || index > 4095) throw refuse('extension', offset, 'legacy PAX index bound');
      const set = families.get(indexed[1]) ?? new Set(); set.add(index); families.set(indexed[1], set);
    }
  }
  for (const indices of families.values()) if (indices.size !== Math.max(...indices) + 1) throw refuse('extension', offset, 'noncontiguous legacy PAX indices');
}
function confinedName(name, allowDot = false, directory = false) {
  if (!name || /[\\\x00-\x1f\x7f\ufffd]/u.test(name)) return false;
  const selected = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  return !!selected && selected.split('/').every(part => part && part !== '..' && (allowDot || part !== '.'));
}
function legacyPath(name, directory, offset, state, aliases) {
  if (!confinedName(name, aliases && !directory, directory)) throw refuse('path', offset, 'unsafe registry path');
  const selected = directory && name.endsWith('/') ? name.slice(0, -1) : name, parts = selected.split('/');
  const envelope = parts.shift();
  if (envelope === '.' || envelope === '..') throw refuse('path', offset, 'unsafe registry envelope');
  if (state.envelope === undefined) state.envelope = envelope;
  if (state.envelope !== envelope) throw refuse('path', offset, 'mixed registry envelopes');
  const local = parts.join('/'), projected = parts.filter(x => x !== '.').join('/');
  if (!directory && !projected) throw refuse('path', offset, 'registry root is not a file');
  return { local, projected };
}
function equalOccurrence(a, b, tar) {
  if (a.extensionOrdinal !== null || b.extensionOrdinal !== null || a.layout !== 'ustar' || b.layout !== 'ustar' || !['0','\0'].includes(a.rawType) || a.rawType !== b.rawType || a.mode !== b.mode || a.rawSize !== b.rawSize || a.effectiveSize !== b.effectiveSize) return false;
  if (!tar.subarray(a.headerOffset + BLOCK, a.headerOffset + BLOCK + a.effectiveSize).equals(tar.subarray(b.headerOffset + BLOCK, b.headerOffset + BLOCK + b.effectiveSize))) return false;
  const masked = hex => { const bytes = Buffer.from(hex, 'hex'); bytes.fill(0, 0, 100); bytes.fill(0, 148, 156); bytes.fill(0, 345, 500); return bytes; };
  return masked(a.rawHeaderHex).equals(masked(b.rawHeaderHex));
}
function projectionResult(tar, profile, occurrences, extensions, manifestText, members, groups) {
  const manifest = JSON.parse(manifestText);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw refuse('manifest', undefined, 'registry manifest object required');
  const aliases = profile === profiles[2];
  if (aliases) {
    if (manifest.directories?.bin !== undefined) throw refuse('manifest', undefined, 'directory bin projection unsupported');
    let declarations = [];
    if (typeof manifest.bin === 'string') declarations = [[typeof manifest.name === 'string' ? manifest.name.split('/').at(-1) : '', manifest.bin]];
    else if (manifest.bin !== undefined) {
      if (!manifest.bin || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin)) throw refuse('manifest', undefined, 'invalid bin declarations');
      declarations = Object.entries(manifest.bin);
    }
    const excluded = new Set(['package.json']);
    for (const [name, value] of declarations) {
      if (!confinedName(name) || name.includes('/') || typeof value !== 'string' || !confinedName(value, true)) throw refuse('manifest', undefined, 'unconfined bin declaration');
      const target = value.split('/').filter(x => x !== '.').join('/');
      if (!target) throw refuse('manifest', undefined, 'empty bin target');
      excluded.add(target);
    }
    for (const path of excluded) {
      const group = groups.get(path);
      if (group && (group.length !== 1 || group[0].localPath !== path || group[0].interpretedKind !== 'File')) throw refuse('conflict', group[0].headerOffset, 'manifest/bin alias forbidden');
    }
  }
  const expandedSHA256 = sha256(tar);
  const rawInventorySHA256 = sha256(JSON.stringify([1, profile, expandedSHA256, occurrences, extensions]));
  const targets = [...groups].filter(([, group]) => group[0].interpretedKind === 'File').map(([path, group]) => ({path, occurrenceOrdinals: group.map(x => x.ordinal), selectedOrdinal: group.at(-1).ordinal}));
  const projection = {version:1, profile, rawInventorySHA256, manifestText, members, targets};
  projection.projectionSHA256 = sha256(JSON.stringify([1, profile, rawInventorySHA256, manifestText, members, targets]));
  return { sourceArchive: {version:1, expandedSHA256, profile, manifestText, occurrences, extensions, rawInventorySHA256}, projection };
}
function carrierPath(path, directory, offset) {
  // A type5 container need not carry a slash. Its empty local path enters
  // the same duplicate/conflict accounting as the existing package/ spelling.
  if (directory && path === 'package') return '';
  if (path.includes('\ufffd')) throw refuse('encoding', offset, 'ambiguous archive member name');
  if (!path.startsWith('package/') || /[\\\x00-\x1f\x7f]/u.test(path))
    throw refuse('path', offset, 'unsafe archive member path');
  const local = path.slice('package/'.length);
  if (directory && local === '') return '';
  const selected = directory && local.endsWith('/') ? local.slice(0, -1) : local;
  if (!selected || !selected.split('/').every(part => part && part !== '.' && part !== '..'))
    throw refuse('path', offset, 'unsafe or aliased archive member path');
  return selected;
}
function bodyEnd(offset, size, length) {
  const padded = Math.ceil(size / BLOCK) * BLOCK;
  if (!Number.isSafeInteger(padded) || !Number.isSafeInteger(offset + BLOCK + padded))
    throw refuse('accounting', offset, 'unsafe archive framing arithmetic');
  const end = offset + BLOCK + padded;
  if (end > length) throw refuse('truncated', offset, 'truncated archive member body');
  return end;
}
/** Inspect held, already bounded decompressed bytes. No pathname is reopened. */
export function inspectPackedCarrierArchive(tar, limits, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'profile')) throw refuse('wire-profile', undefined, 'exact scanner options required');
  const profile = options.profile ?? profiles[0];
  if (!profiles.includes(profile)) throw refuse('wire-profile', undefined, 'unknown archive profile');
  const legacy = profile !== profiles[0], aliases = profile === profiles[2];
  const occurrences = [], extensions = [], groups = new Map(), pathState = {};
  let retainedBytes = 0, metadataPayloadBytes = 0, pendingExtension = null, headerCount = 0;
  const retain = value => { retainedBytes += Buffer.byteLength(JSON.stringify(value)); if (retainedBytes > 16 * 1024 * 1024) throw refuse('limit', undefined, 'retained archive evidence bound exceeded'); };
  if (!Buffer.isBuffer(tar)) throw refuse('wire-profile', undefined, 'held TAR bytes required');
  for (const name of ['members', 'bytes', 'tarBytes', 'metadataBytes'])
    if (!Number.isSafeInteger(limits?.[name]) || limits[name] < 1) throw refuse('limit', undefined, 'finite scanner bound required');
  if (!tar.length || tar.length % BLOCK !== 0) throw refuse('truncated', 0, 'archive is not complete TAR blocks');
  if (tar.length > limits.tarBytes) throw refuse('limit', 0, 'expanded archive bound exceeded');
  const members = [], headers = [], seen = new Set();
  let pax, extensionBytes = 0, payloadBytes = 0, offset = 0, endOffset, manifestText;
  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (isZero(block)) {
      if (pax) throw refuse('extension', offset, 'orphan PAX header');
      if (offset + 2 * BLOCK > tar.length || !isZero(tar.subarray(offset + BLOCK, offset + 2 * BLOCK)))
        throw refuse('eof', offset, 'two zero archive end blocks required');
      endOffset = offset + 2 * BLOCK;
      if (!isZero(tar.subarray(endOffset))) throw refuse('tail', endOffset, 'nonzero data after archive end');
      break;
    }
    const raw = headerFields(block, offset, legacy);
    if (raw.layout === 'old-gnu-zero-suffix' && !['0', '\0', '5'].includes(raw.type)) throw refuse('wire-profile', offset, 'oldGNU profile only supports regular files/directories');
    if (legacy && ++headerCount > limits.members) throw refuse('limit', offset, 'all archive header bound exceeded');
    if (legacy && !confinedName(raw.name, aliases && pendingExtension === null && !['x','X','5'].includes(raw.type), raw.type === '5' || raw.name.endsWith('/'))) throw refuse('path', offset, 'unsafe raw registry name');
    if (['g', 'L', 'K'].includes(raw.type)) throw refuse('extension', offset, 'unreceived global or GNU extension');
    if (raw.hasLinkName) throw refuse('type', offset, 'linkname forbidden');
    if (['x', 'X'].includes(raw.type)) {
      if (pax) throw refuse('extension', offset, 'stacked PAX headers');
      if (raw.size > limits.metadataBytes) throw refuse('limit', offset, 'PAX metadata bound exceeded');
      const end = bodyEnd(offset, raw.size, tar.length);
      const payload = tar.subarray(offset + BLOCK, offset + BLOCK + raw.size);
      pax = paxRecords(payload, offset + BLOCK, legacy);
      if (legacy) {
        metadataPayloadBytes += raw.size;
        if (metadataPayloadBytes > limits.metadataBytes) throw refuse('limit', offset, 'total PAX metadata bound exceeded');
        pendingExtension = extensions.length;
        const extension = {ordinal:pendingExtension, headerOffset:offset, rawHeaderHex:block.toString('hex'), payloadOffset:offset+BLOCK, payloadBytes:raw.size, payloadSHA256:sha256(payload), records:Object.entries(pax).map(([key,value]) => [key,String(value)])};
        retain(extension); extensions.push(extension);
      }
      extensionBytes += end - offset;
      offset = end; continue;
    }
    if (!['0', '\0', '5'].includes(raw.type)) throw refuse('type', offset, 'nonregular archive member');
    const name = pax?.path ?? raw.name, size = pax?.size ?? raw.size;
    const directory = raw.type === '5' || name.endsWith('/');
    if (directory && (raw.size !== 0 || size !== 0)) throw refuse('number', offset, 'directory has nonzero raw/effective size');
    if (legacy && pax?.['NODETAR.type'] !== undefined && (!['0','\0'].includes(raw.type) || directory)) throw refuse('extension', offset, 'PAX type disagrees with header');
    const mapped = legacy ? legacyPath(name, directory, offset, pathState, aliases) : null;
    const path = legacy ? mapped.projected : carrierPath(name, directory, offset);
    if (legacy && mapped.local !== path && (directory || pendingExtension !== null || raw.layout !== 'ustar')) throw refuse('conflict', offset, 'unsupported singleton alias metadata/type');
    pax = undefined;
    if (seen.has(path) && !aliases) throw refuse('conflict', offset, 'duplicate or aliased archive member');
    seen.add(path);
    if (seen.size > limits.members) throw refuse('limit', offset, 'archive member bound exceeded');
    const end = bodyEnd(offset, size, tar.length);
    headers.push({ path: name, type: directory ? 'Directory' : 'File', mode: raw.mode, size });
    let repeated = false;
    if (legacy) {
      const occurrence = {ordinal:occurrences.length, headerOffset:offset, rawHeaderHex:block.toString('hex'), rawName:raw.name, effectiveName:name, rawType:raw.type, interpretedKind:directory?'Directory':'File', layout:raw.layout, mode:raw.mode, rawSize:raw.size, effectiveSize:size, localPath:mapped.local, projectedPath:path, payloadSHA256:directory?null:sha256(tar.subarray(offset+BLOCK,offset+BLOCK+size)), extensionOrdinal:pendingExtension};
      pendingExtension = null;
      const group = groups.get(path) ?? [];
      if (group.length && (directory || group[0].interpretedKind !== 'File' || !equalOccurrence(group[0], occurrence, tar))) throw refuse('conflict', offset, 'non-idempotent registry occurrence');
      repeated = group.length > 0; group.push(occurrence); groups.set(path,group); retain(occurrence); occurrences.push(occurrence);
    }
    if (!directory) {
      payloadBytes += size;
      if (!Number.isSafeInteger(payloadBytes) || payloadBytes > limits.bytes) throw refuse('limit', offset, 'archive file payload bound exceeded');
      const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
      if (!repeated) members.push({ path, kind: 'file', bytes: size, sha256: sha256(body), mode: raw.mode });
      // Intentionally propagate the native fatal manifest decoder error.
      if (path === 'package.json') manifestText = utf8.decode(body);
    }
    offset = end;
  }
  if (endOffset === undefined) throw refuse('eof', offset, 'archive end marker required');
  if (manifestText === undefined) throw refuse('manifest', endOffset, 'exact package manifest required');
  // PR24's nonquadratic sorted-prefix conflict proof, preserving member order.
  const sortedMembers = [...seen].sort();
  for (const { path } of members) {
    const prefix = path + '/';
    let low = 0, high = sortedMembers.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (sortedMembers[middle] < prefix) low = middle + 1;
      else high = middle;
    }
    if (sortedMembers[low]?.startsWith(prefix)) throw refuse('conflict', endOffset, 'archive file also names a parent directory');
  }
  const accountedEndOffset = headers.reduce((sum, header) => sum + BLOCK + Math.ceil(header.size / BLOCK) * BLOCK, 2 * BLOCK + extensionBytes);
  if (!Number.isSafeInteger(accountedEndOffset) || accountedEndOffset !== endOffset)
    throw refuse('accounting', endOffset, 'archive header accounting is incomplete');
  const result = { members, manifestText, headers, parserEndOffset: endOffset, accountedEndOffset };
  if (legacy) {
    Object.assign(result, projectionResult(tar, profile, occurrences, extensions, manifestText, members, groups));
    if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024) throw refuse('limit', endOffset, 'complete retained archive result bound exceeded');
    const source = JSON.stringify(result.sourceArchive), projection = JSON.stringify(result.projection);
    if (Buffer.byteLength(source) + Buffer.byteLength(projection) > 16 * 1024 * 1024) throw refuse('limit', endOffset, 'retained private proof bound exceeded');
    retainedProjections.set(result.projection, {source, projection});
  }
  return result;
}
