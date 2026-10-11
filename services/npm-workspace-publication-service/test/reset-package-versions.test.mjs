import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {planPackageVersionReset,applyPackageVersionResetWorkspace,verifyPackageVersionResetRegistry,resetMaps} from '../src/reset-package-versions.mjs';
test('receiving verification rejects stable-major identities and mismatched artifact evidence',async()=>{
 const plan={profile:'org.561-group.package-version-reset.v1',mappings:[{name:'@test/a',from:'1.0.0',to:'0.1.0'}]};
 const result=await verifyPackageVersionResetRegistry({plan,packuments:[{name:'@test/a',versions:{'1.0.0':{name:'@test/a',version:'1.0.0'}},'dist-tags':{latest:'1.0.0'}}],artifacts:[{name:'@test/a',version:'0.1.0',integrity:'new'}]});
 assert.equal(result.ok,false);assert.equal(result.failures.length,2);
 assert.throws(()=>resetMaps({...plan,mappings:[...plan.mappings,...plan.mappings]}),/duplicate/);
});
test('one registry/source map handles duplicate archives, lock integrity, concurrent source additions and idempotence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'version-workspace-')),backupRoot=join(root,'.tmp','backup');
 try{
  const name='@red-cup-engineering/example';
  for(const folder of ['live','archive']){await mkdir(join(root,folder));await writeFile(join(root,folder,'package.json'),JSON.stringify({name,version:'1.0.0',dependencies:{[name]:'^1.0.0',semver:'7.7.2'}}));}
  await writeFile(join(root,'live','package-lock.json'),JSON.stringify({name,version:'1.0.0',lockfileVersion:3,packages:{'':{name,version:'1.0.0'},['node_modules/'+name]:{version:'1.0.0',integrity:'old',resolved:'old'}}}));
  const plan=await planPackageVersionReset({root,packuments:[{name,versions:{'0.3.0':{},'1.0.0':{}}}]});
  assert.equal(plan.mappings[0].to,'0.4.0');
  const path=join(root,'live','package.json'),current=JSON.parse(await readFile(path));current.description='concurrent addition';await writeFile(path,JSON.stringify(current));
  const artifacts=[{name,from:'1.0.0',version:'0.4.0',integrity:'sha512-new',tarball:'https://registry.test/new.tgz'}];
  assert.equal((await applyPackageVersionResetWorkspace({root,plan,backupRoot,artifacts})).metrics.changedFiles,3);
  const next=JSON.parse(await readFile(path));assert.equal(next.description,current.description);assert.equal(next.dependencies.semver,'7.7.2');assert.equal(next.dependencies[name],'0.4.0');
  const lock=JSON.parse(await readFile(join(root,'live','package-lock.json')));assert.equal(lock.packages['node_modules/'+name].integrity,'sha512-new');
  assert.equal((await applyPackageVersionResetWorkspace({root,plan,backupRoot,artifacts})).metrics.changedFiles,0);
  next.version='2.0.0';await writeFile(path,JSON.stringify(next));await assert.rejects(applyPackageVersionResetWorkspace({root,plan,backupRoot,artifacts}),/unplanned package identity/);
 }finally{await rm(root,{recursive:true,force:true})}
});
