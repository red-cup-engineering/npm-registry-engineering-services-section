import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removePublicLeftovers} from '../src/leftovers.mjs';

async function store() {
  const storage=await mkdtemp(join(tmpdir(),'registry-leftovers-'));
  for(const [name,file] of [['debug','package.json'],['@solana/web3','package.json'],['@solana/web3','web3-1.0.0.tgz'],['@red-cup-engineering/keep','package.json'],['persistent-private','package.json'],['@emsenn/also','package.json']]) {
    await mkdir(join(storage,name),{recursive:true});
    await writeFile(join(storage,name,file),'x'.repeat(10));
  }
  await writeFile(join(storage,'.token-db.json'),'{}');
  return storage;
}
const configuration={privateScopes:['@red-cup-engineering','@emsenn'],privateNames:['persistent-private'],cachePublicTarballs:false};

test('public names left on disk before memory-only metadata are removed; private names and the token database are not',async t=>{
  const storage=await store();
  t.after(()=>rm(storage,{recursive:true,force:true}));
  const report=await removePublicLeftovers({configuration,storage});
  assert.equal(report.removedNames,2);
  assert.equal(report.freedBytes,30);
  assert.deepEqual((await readdir(storage)).sort(),['.token-db.json','@emsenn','@red-cup-engineering','persistent-private']);
});

test('a configuration that keeps a public cache loses nothing',async t=>{
  const storage=await store();
  t.after(()=>rm(storage,{recursive:true,force:true}));
  const report=await removePublicLeftovers({configuration:{...configuration,cachePublicTarballs:true},storage});
  assert.equal(report.removedNames,0);
  assert.ok((await readdir(storage)).includes('debug'));
});

test('a store that does not exist yet is nothing to remove',async()=>{
  const report=await removePublicLeftovers({configuration,storage:join(tmpdir(),'registry-leftovers-absent')});
  assert.equal(report.removedNames,0);
});
