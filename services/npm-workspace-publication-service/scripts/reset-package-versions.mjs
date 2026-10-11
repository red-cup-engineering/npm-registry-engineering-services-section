#!/usr/bin/env node
import { readFile,writeFile } from "node:fs/promises";
import { planPackageVersionReset, applyPackageVersionResetWorkspace, resetMaps, snapshotHouseRegistry, verifyPackageVersionResetRegistry } from "../src/reset-package-versions.mjs";
import { applyVerdaccioZeroMajorReset } from "../src/verdaccio-version-reset-executor.mjs";
const args=process.argv.slice(2), get=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1]};
const usage="reset-package-versions snapshot --storage DIR --output JSON\nreset-package-versions plan --root DIR --packuments JSON --output JSON\nreset-package-versions registry --storage DIR --backup DIR --packuments JSON --plan JSON\nreset-package-versions workspace --root DIR --backup DIR --plan JSON --registry-state JSON\nreset-package-versions verify --packuments JSON --plan JSON --registry-state JSON [--registry URL] [--output JSON]\nStop Verdaccio before snapshot/apply; restart after completion. Resume with exactly the same registry command and inputs. Backup must be outside served storage, on the same filesystem. Python binding: reset-python-package-versions --root DIR --names OWNED,NAMES [--apply --backup DIR].\n";
if(args.includes("--help")){console.log(usage);process.exit(0)}
const read=async flag=>JSON.parse(await readFile(get(flag),"utf8"));
try{
 let result;
 if(args[0]==="snapshot"){
  result=await snapshotHouseRegistry(get('--storage'));
  await writeFile(get('--output'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({packages:result.length}));
 }else if(args[0]==="plan"){
  result=await planPackageVersionReset({root:get("--root"),packuments:await read("--packuments")});
  await writeFile(get("--output"),JSON.stringify(result,null,2)+"\n",{flag:"wx"});console.log(JSON.stringify(result.metrics));
 }else if(args[0]==="registry"){
  const plan=await read("--plan");
  result=await applyVerdaccioZeroMajorReset({storage:get("--storage"),backupRoot:get("--backup"),packuments:await read("--packuments"),maps:resetMaps(plan),onProgress:p=>{if(p.count%50===0)process.stderr.write(JSON.stringify(p)+"\n")}});
  console.log(JSON.stringify({staged:result.staged,metadata:result.metadata,alreadyApplied:result.alreadyApplied}));
 }else if(args[0]==="verify"){
  result=await verifyPackageVersionResetRegistry({packuments:await read('--packuments'),plan:await read('--plan'),artifacts:(await read('--registry-state')).artifacts,registry:get('--registry')});
  if(get('--output'))await writeFile(get('--output'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,failures:result.failures.slice(0,10)}));if(!result.ok)process.exitCode=1;
 }else if(args[0]==="workspace"){
  const state=await read("--registry-state");
  if(state.phase!=="complete")throw new Error("registry reset must be complete before workspace activation");
  result=await applyPackageVersionResetWorkspace({root:get("--root"),plan:await read("--plan"),backupRoot:get("--backup"),artifacts:state.artifacts});console.log(JSON.stringify(result.metrics));
 }else throw new Error(usage);
}catch(error){console.error(error.stack);process.exitCode=1}
