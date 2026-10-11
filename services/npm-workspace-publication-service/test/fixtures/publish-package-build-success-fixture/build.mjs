import { mkdir, writeFile } from "node:fs/promises";

await mkdir(new URL("./dist/", import.meta.url), { recursive: true });
await writeFile(new URL("./dist/x.mjs", import.meta.url), "export default 1;\n");
