import { randomUUID } from "node:crypto";
import { execFile as callback } from "node:child_process";
import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import semver from "semver";
import { planZeroMajorVersionMap, rewriteZeroMajorCarrier } from "./zero-major-version-reset.mjs";
import { writeFileBytes } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";
const run = promisify(callback);
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const scopes = new Set(["@561-group", "@causeway-services", "@coesite-operations", "@emsenn", "@emsweb", "@harmonious-union", "@koios-news", "@lenticule-science", "@red-cup-engineering", "@red-cup-science", "@rsc-quiescent", "@turntide-islands", "@union-officer-academy"]);
export async function snapshotHouseRegistry(storage) {
  const result=[];
  for(const scope of [...scopes].sort()) {
    let entries;try{entries=await readdir(join(storage,scope),{withFileTypes:true})}catch(error){if(error.code==='ENOENT')continue;throw error}
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if(!entry.isDirectory())continue;
      const p=await optionalJSON(join(storage,scope,entry.name,'package.json'));
      if(p?.versions && p.name===scope+'/'+entry.name)result.push(p);
    }
  }
  return result;
}
async function optionalJSON(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } }
const atomic = (path, value) => writeFileBytes(path, bytes(value));

/** Scan actual owned package descriptors, including archived carriers. Installed
 * third-party trees and temporary fixtures are never namespace authorities. */
export async function versionResetWorkspaceCarriers(root) {
  const { stdout } = await run("rg", ["--files","--hidden","-g","package.json","-g","!**/node_modules/**","-g","!.git/**","-g","!.tmp/**","-g","!**/.tmp/**","-g","!**/.lake/**","-g","!**/.venv/**","-g","!**/vendor/**"], {cwd:root,maxBuffer:32*1024*1024});
  const result=[];
  for(const path of stdout.trim().split("\n").filter(Boolean)) {
    const full=join(root,path), original=await readFile(full);
    let manifest;try{manifest=JSON.parse(original)}catch{continue}
    if(typeof manifest.name!=="string" || typeof manifest.version!=="string" || !semver.valid(manifest.version)) continue;
    if(manifest.name.startsWith("@") && !scopes.has(manifest.name.split("/")[0])) continue;
    const lockPath=join(dirname(full),"package-lock.json"), shrinkPath=join(dirname(full),"npm-shrinkwrap.json");
    result.push({path,manifest,originalHash:sha256Hex(original),packageLock:await optionalJSON(lockPath),shrinkwrap:await optionalJSON(shrinkPath)});
  }
  return result;
}

/** A single map from the union of observed registry and workspace identities.
 * A workspace-only identity never masquerades as a published registry version. */
export async function planPackageVersionReset({root,packuments}) {
  const started=Date.now(), carriers=await versionResetWorkspaceCarriers(root), versions=new Map();
  const admit=(name,version)=>{if(!versions.has(name))versions.set(name,new Set());versions.get(name).add(version)};
  for(const p of packuments) for(const version of Object.keys(p.versions)) admit(p.name,version);
  for(const c of carriers) admit(c.manifest.name,c.manifest.version);
  // Include exact references to otherwise missing historical identities. They
  // remain visibly unpublished; the operation does not fabricate their code.
  for(const c of carriers) for(const field of ["dependencies","devDependencies","peerDependencies","optionalDependencies"])
    for(const [name,version] of Object.entries(c.manifest[field]??{})) if(versions.has(name)&&semver.valid(version)) admit(name,version);
  const mappings=[...versions].sort(([a],[b])=>a.localeCompare(b)).flatMap(([name,v])=>planZeroMajorVersionMap([...v]).map(row=>({name,...row})));
  return {profile:"org.561-group.package-version-reset.v1",root:resolve(root),mappings,workspaceCarriers:carriers.map(c=>({path:c.path,name:c.manifest.name,version:c.manifest.version,originalHash:c.originalHash})),
    registryDigest:sha256Hex(bytes(packuments)),metrics:{workspaceCarriers:carriers.length,registryPackages:packuments.length,mappedVersions:mappings.length,elapsedMs:Date.now()-started}};
}
export function resetMaps(plan) {
  if(plan?.profile!=='org.561-group.package-version-reset.v1'||!Array.isArray(plan.mappings))throw new TypeError('unrecognized package version reset plan');
  const maps=new Map(),targets=new Set();for(const {name,from,to} of plan.mappings){
    if(typeof name!=='string'||!semver.valid(from)||semver.major(from)<1||!semver.valid(to)||semver.major(to)!==0)throw new TypeError('invalid package version mapping');
    if(targets.has(name+'@'+to)||maps.get(name)?.has(from))throw new TypeError('duplicate package version mapping');targets.add(name+'@'+to);
    if(!maps.has(name))maps.set(name,new Map());maps.get(name).set(from,to)
  }return maps;
}

/** Audit the receiving registry without exposing thousands of descriptors to
 * an agent. With a URL, read the public HTTP contract in bounded parallelism. */
export async function verifyPackageVersionResetRegistry({packuments,plan,artifacts=[],registry}) {
  const failures=[],maps=resetMaps(plan),expected=new Map(packuments.map(p=>[p.name,p])),observed=new Map();
  const queue=[...expected.keys()];let requests=0;
  if(registry)await Promise.all(Array.from({length:8},async()=>{while(queue.length){const name=queue.shift();try{requests++;const response=await fetch(new URL(encodeURIComponent(name),registry),{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('HTTP '+response.status);observed.set(name,await response.json())}catch(error){failures.push({name,error:error.message})}}}));
  else for(const [name,p] of expected)observed.set(name,p);
  for(const [name,p] of observed){
    for(const [version,manifest] of Object.entries(p.versions??{})){
      if(!semver.valid(version)||semver.major(version)>0)failures.push({name,version,error:'non-zero major'});
      if(manifest.name!==name||manifest.version!==version)failures.push({name,version,error:'manifest identity differs'});
      if(rewriteZeroMajorCarrier({manifest},maps).dependencyEdits.length)failures.push({name,version,error:'unrepaired dependency'});
    }
    for(const [tag,version] of Object.entries(p['dist-tags']??{}))if(!p.versions?.[version])failures.push({name,tag,version,error:'dangling tag'});
    const wanted=expected.get(name);
    if(JSON.stringify(Object.keys(p.versions??{}).sort())!==JSON.stringify(Object.keys(wanted.versions).sort()))failures.push({name,error:'public version set differs from storage'});
    for(const [tag,version] of Object.entries(wanted['dist-tags']??{}))if(p['dist-tags']?.[tag]!==version)failures.push({name,tag,error:'public tag differs from storage'});
  }
  for(const a of artifacts){const p=observed.get(a.name)?.versions?.[a.version];if(p?.dist?.integrity!==a.integrity)failures.push({name:a.name,version:a.version,error:'artifact integrity differs'})}
  return {ok:failures.length===0,packages:observed.size,requests,artifacts:artifacts.length,failures};
}

/** Apply typed descriptor edits, using exact replacement artifact hashes.
 * Current source is read at application time so unrelated concurrent edits
 * survive. Every write has an immediate byte precondition and a backup. */
export async function applyPackageVersionResetWorkspace({root,plan,backupRoot,artifacts=[]}) {
  const started=Date.now(), maps=resetMaps(plan), artifactMap=new Map(artifacts.map(a=>[a.key??(a.name+"\u0000"+a.from),a])), carriers=await versionResetWorkspaceCarriers(root);
  const writes=[],seen=new Set();
  for(const c of carriers){
    if(semver.major(c.manifest.version)>0 && !maps.get(c.manifest.name)?.has(c.manifest.version))throw new Error('unplanned package identity: '+c.manifest.name+'@'+c.manifest.version);
    const rewritten=rewriteZeroMajorCarrier(c,maps,{artifacts:artifactMap});
    const candidates=[["package.json",rewritten.manifest],["package-lock.json",rewritten.packageLock]];
    if(c.shrinkwrap) candidates.push(["npm-shrinkwrap.json",rewriteZeroMajorCarrier({manifest:c.manifest,packageLock:c.shrinkwrap},maps,{artifacts:artifactMap}).packageLock]);
    for(const [file,value] of candidates){
      if(value===undefined)continue;
      const target=join(root,dirname(c.path),file);if(seen.has(target))continue;seen.add(target);
      const before=await readFile(target);if(JSON.stringify(JSON.parse(before))===JSON.stringify(value))continue;
      writes.push({path:relative(root,target),target,before,after:bytes(value)});
    }
  }
  for(const write of writes) {
    const backup=join(backupRoot,write.path);await mkdir(dirname(backup),{recursive:true});
    try{await writeFile(backup,write.before,{flag:"wx"})}catch(error){if(error.code!=="EEXIST")throw error}
    if(!Buffer.from(await readFile(write.target)).equals(write.before))throw new Error("concurrent descriptor edit: "+write.path);
    const temporary=write.target+"."+randomUUID()+".tmp";await writeFile(temporary,write.after);await rename(temporary,write.target);
  }
  const result={profile:plan.profile,writes:writes.map(w=>({path:w.path,before:sha256Hex(w.before),after:sha256Hex(w.after)})),metrics:{changedFiles:writes.length,bytesWritten:writes.reduce((n,w)=>n+w.after.length,0),elapsedMs:Date.now()-started}};
  await atomic(join(backupRoot,"workspace-result.json"),result);return result;
}
