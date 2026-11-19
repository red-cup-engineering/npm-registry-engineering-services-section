import {readdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Public npm names are the uplink's, held in memory only (0.1.6). The registry's store holds the house's private
 * names and nothing else, so whatever a public name left on disk before that (packuments and tarballs from
 * earlier versions) is dead weight that only this service can name as such. It removes it when it starts, which is
 * when a release that carries this rule begins serving: no timer, no hand.
 *
 * Only `cachePublicTarballs: false` declares the memory-only mode; a configuration without it keeps its public cache
 * and nothing is removed. A name is private when the configuration's `privateNames` or `privateScopes` say so, and a
 * private name is never read, let alone removed. Returns what was removed.
 */
export async function removePublicLeftovers({configuration, storage}) {
  const report={kind:'registry-public-leftovers.v1',storage,removedNames:0,freedBytes:0,kept:0};
  if(configuration.cachePublicTarballs!==false)return {...report,skipped:'the configuration keeps a public cache'};
  const privateScopes=configuration.privateScopes??[],privateNames=configuration.privateNames??[];
  const isPrivate=name=>privateNames.includes(name)||privateScopes.includes(name.split('/')[0]);
  const size=async dir=>{let n=0;for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);n+=e.isDirectory()?await size(p):(await stat(p)).size;}return n;};
  const removeName=async(name,dir)=>{
    if(isPrivate(name)){report.kept+=1;return;}
    report.freedBytes+=await size(dir);
    await rm(dir,{recursive:true,force:true});
    report.removedNames+=1;
  };
  let entries;
  try {entries=await readdir(storage,{withFileTypes:true});} catch(error) {if(error.code==='ENOENT')return report;throw error;}
  for(const entry of entries) {
    // `-` holds the store's own blobs and no package name begins with `-` or `.`: neither is a public name's leftover.
    if(!entry.isDirectory()||entry.name.startsWith('-')||entry.name.startsWith('.'))continue;
    const dir=join(storage,entry.name);
    if(!entry.name.startsWith('@')){await removeName(entry.name,dir);continue;}
    // a private scope is kept whole without being read; a public scope's names go one by one, then the empty scope
    if(isPrivate(entry.name)){report.kept+=1;continue;}
    for(const inner of await readdir(dir,{withFileTypes:true}))if(inner.isDirectory())await removeName(`${entry.name}/${inner.name}`,join(dir,inner.name));
    if(!(await readdir(dir)).length)await rm(dir,{recursive:true});
  }
  return report;
}
