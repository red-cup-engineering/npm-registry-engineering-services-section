import { gzipSync } from "node:zlib";

/** Build an npm-shaped tarball in memory: gzip over ustar, every file under `package/`. Test support only. */
function header(name, size, type = "0") {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100); block.write("0000000\0", 108); block.write("0000000\0", 116);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}
const padded = (bytes) => Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);

export function tarEntry(path, content, type = "0") {
  const bytes = Buffer.from(content);
  if (Buffer.byteLength(path) <= 100) return Buffer.concat([header(path, bytes.length, type), padded(bytes)]);
  const record = ` path=${path}\n`;
  let length = Buffer.byteLength(record) + 1;
  while (String(length).length + Buffer.byteLength(record) !== length) length = String(length).length + Buffer.byteLength(record);
  const pax = Buffer.from(`${length}${record}`);
  return Buffer.concat([header("PaxHeader/entry", pax.length, "x"), padded(pax), header(path.slice(0, 100), bytes.length, type), padded(bytes)]);
}

export function packTarball(files, { root = "package" } = {}) {
  const entries = Object.entries(files).map(([path, content]) => tarEntry(`${root}/${path}`, typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content)));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/** A tarball for `name@version`: a package.json merged over the defaults, plus `files`. */
export function packagedVersion(name, version, { manifest = {}, files = {} } = {}) {
  return packTarball({
    "package.json": { name, version, type: "module", exports: "./index.mjs", repository: { type: "git", url: "https://github.com/registry-fixture/capability.git" }, ...manifest },
    "index.mjs": "export const fixture = true;\n",
    ...files,
  });
}
