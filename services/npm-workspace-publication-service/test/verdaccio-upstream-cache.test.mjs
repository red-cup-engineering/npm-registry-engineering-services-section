import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {cacheVerdaccioUpstreamRelease} from '../src/verdaccio-upstream-cache.mjs';
test('exact upstream cache admission verifies bytes, preserves tags and backs up metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'registry-admit-'));
 const archive=Buffer.from('verified archive');const integrity='sha512-'+createHash('sha512').update(archive).digest('base64');
 const manifest={name:'undici',version:'6.28.1',dist:{integrity,tarball:'https://registry.npmjs.org/undici/-/undici-6.28.1.tgz'}};
 const fetcher=async(url)=>String(url).endsWith('.tgz')?new Response(archive):Response.json(manifest);
 const prior={name:'undici',versions:{},'dist-tags':{latest:'6.28.0'},_distfiles:{}};
 try{
  await mkdir(join(root,'undici'));const path=join(root,'undici','package.json');const original=JSON.stringify(prior);await writeFile(path,original);
  const input={storage:root,packageName:'undici',version:'6.28.1',fetcher};
  assert.equal((await cacheVerdaccioUpstreamRelease(input)).applied,false);assert.equal(await readFile(path,'utf8'),original);
  const result=await cacheVerdaccioUpstreamRelease({...input,apply:true,backupDirectory:join(root,'backup')});
  assert.equal(result.applied,true);assert.equal(await readFile(join(root,'backup',result.priorDigest+'.json'),'utf8'),original);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8'))['dist-tags'],prior['dist-tags']);
  assert.equal((await cacheVerdaccioUpstreamRelease({...input,apply:true})).changed,false);
  await assert.rejects(cacheVerdaccioUpstreamRelease({...input,fetcher:async(url)=>String(url).endsWith('.tgz')?new Response('corrupt'):Response.json(manifest)}),/integrity mismatch/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('first admission creates exact metadata and archive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'registry-first-'));const archive=Buffer.from('first');const integrity='sha512-'+createHash('sha512').update(archive).digest('base64');const manifest={name:'xml-naming',version:'0.3.0',dist:{integrity,tarball:'https://registry.npmjs.org/xml-naming/-/xml-naming-0.3.0.tgz'}};
 try { const result=await cacheVerdaccioUpstreamRelease({storage:root,packageName:'xml-naming',version:'0.3.0',expectedIntegrity:integrity,fetcher:async u=>String(u).endsWith('.tgz')?new Response(archive):Response.json(manifest),backupDirectory:join(root,'backup'),apply:true}); assert.equal(result.applied,true); assert.equal(JSON.parse(await readFile(join(root,'xml-naming','package.json'))).versions['0.3.0'].dist.integrity,integrity); } finally {await rm(root,{recursive:true,force:true});}
});
