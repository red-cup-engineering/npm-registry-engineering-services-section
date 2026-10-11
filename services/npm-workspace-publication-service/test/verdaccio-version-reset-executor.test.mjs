import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { applyVerdaccioZeroMajorReset } from "../src/verdaccio-version-reset-executor.mjs";
const run = promisify(execFile), digest = (a, b) => createHash(a).update(b).digest(a === "sha512" ? "base64" : "hex");

test("reset resumes after a partial swap, keeps same-basename scopes distinct, and rejects concurrent edits", async () => {
  const root=await mkdtemp(join(tmpdir(),'reset-resume-')),storage=join(root,'store'),backupRoot=join(root,'backup'),packuments=[],maps=new Map();
  try {
    for(const scope of ['one','two']) {
      const name='@'+scope+'/a',dir=join(storage,'@'+scope,'a'),build=join(root,scope,'package');
      await mkdir(dir,{recursive:true});await mkdir(build,{recursive:true});
      const manifest={name,version:'1.0.0',description:scope};
      await writeFile(join(build,'package.json'),JSON.stringify(manifest));
      const file=join(dir,'a-1.0.0.tgz');await run('tar',['-czf',file,'-C',join(root,scope),'package']);
      const content=await readFile(file);
      const p={name,versions:{'1.0.0':{...manifest,dist:{tarball:'https://registry.test/'+name+'/-/a-1.0.0.tgz',integrity:'sha512-'+digest('sha512',content)}}},'dist-tags':{latest:'1.0.0'}};
      await writeFile(join(dir,'package.json'),JSON.stringify(p));packuments.push(p);maps.set(name,new Map([['1.0.0','0.1.0']]));
    }
    const input={storage,backupRoot,packuments,maps,registry:'https://registry.test/'};
    await assert.rejects(applyVerdaccioZeroMajorReset({...input,failAfter:1}),/injected partial failure/);
    const path=join(storage,'@two','a','package.json'),before=await readFile(path);
    await writeFile(path,JSON.stringify({...packuments[1],changed:true}));
    await assert.rejects(applyVerdaccioZeroMajorReset(input),/concurrent registry edit/);
    await writeFile(path,before);
    const applied=await applyVerdaccioZeroMajorReset(input);assert.equal(applied.staged,2);
    for(const scope of ['one','two']) {
      const {stdout}=await run('tar',['-xOzf',join(storage,'@'+scope,'a','a-0.1.0.tgz'),'package/package.json']);
      assert.equal(JSON.parse(stdout).description,scope);assert.equal(JSON.parse(stdout).version,'0.1.0');
    }
    assert.equal((await applyVerdaccioZeroMajorReset(input)).alreadyApplied,true);
    await assert.rejects(applyVerdaccioZeroMajorReset({...input,registry:'https://different.test/'}),/resume input differs/);
  } finally {await rm(root,{recursive:true,force:true})}
});

test("offline Verdaccio reset rewrites an archive and serves its new identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "verdaccio-reset-")), storage = join(root, "store"), backupRoot = join(root, "backup"), dir = join(storage, "@test", "a"), build = join(root, "build");
  try {
    await mkdir(join(build, "package"), { recursive: true }); await mkdir(dir, { recursive: true });
    await writeFile(join(build, "package", "package.json"), JSON.stringify({ name: "@test/a", version: "1.0.0", type: "module", exports: "./index.mjs" }));
    await writeFile(join(build, "package", "index.mjs"), "export default 42;\n");
    const old = join(dir, "a-1.0.0.tgz"); await run("tar", ["-czf", old, "-C", build, "package"]); const bytes = await readFile(old);
    const packument = { name: "@test/a", versions: { "1.0.0": { name: "@test/a", version: "1.0.0", type: "module", exports: "./index.mjs", dist: { tarball: "https://registry.test/@test/a/-/a-1.0.0.tgz", integrity: `sha512-${digest("sha512", bytes)}`, shasum: digest("sha1", bytes) } } }, "dist-tags": { latest: "1.0.0" }, time: { created: "now", "1.0.0": "now" }, _attachments: { "a-1.0.0.tgz": { shasum: digest("sha1", bytes), version: "1.0.0" } }, _distfiles: {} };
    await writeFile(join(dir, "package.json"), JSON.stringify(packument));
    await applyVerdaccioZeroMajorReset({ storage, backupRoot, packuments: [packument], maps: new Map([["@test/a", new Map([["1.0.0", "0.1.0"]])]]), registry: "https://registry.test/" });
    const next = join(dir, "a-0.1.0.tgz"), nextBytes = await readFile(next), metadata = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    await assert.rejects(readFile(old)); assert.equal(metadata["dist-tags"].latest, "0.1.0"); assert.ok(metadata.versions["0.1.0"]); assert.ok(metadata._attachments["a-0.1.0.tgz"]); assert.equal(metadata.versions["0.1.0"].dist.integrity, `sha512-${digest("sha512", nextBytes)}`);
    const consumer = join(root, "consumer"); await mkdir(consumer); await writeFile(join(consumer, "package.json"), '{"type":"module"}'); await run("npm", ["install", "--ignore-scripts", next], { cwd: consumer }); const out = await run(process.execPath, ["--input-type=module", "-e", "import x from '@test/a'; console.log(x)"], { cwd: consumer }); assert.equal(out.stdout.trim(), "42");
  } finally { await rm(root, { recursive: true, force: true }); }
});
