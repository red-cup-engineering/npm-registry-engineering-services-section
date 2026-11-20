import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {createCredentials} from "../src/credentials.mjs";

const program = fileURLToPath(new URL("../bin/admit-publisher.mjs", import.meta.url));
const application = configuration => ({module:"@red-cup-engineering/npm-registry-serving-service/application", export:"npmRegistryHostedApplication", configuration});
const configuration = root => ({hosts:["registry.example.test"], origin:"https://registry.example.test", storage:join(root,"storage"), htpasswd:join(root,"htpasswd"), tokens:join(root,"tokens.jsonl")});
const invoke = (path, flags = []) => spawnSync(process.execPath, [...process.execArgv.filter(arg=>arg.startsWith("--import=")), program, path, "publisher", "--password-environment", "PUBLISHER_TEST_PASSWORD", ...flags], {
  env:{...process.env, PUBLISHER_TEST_PASSWORD:"fixture-publisher-password"}, encoding:"utf8"
});

test("publisher admission follows the selected instance's canonical registry identity", async t => {
  const root=mkdtempSync(join(tmpdir(),"registry-publisher-instance-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const main=configuration(join(root,"main")), vault=configuration(join(root,"vault"));
  mkdirSync(join(root,"vault")); writeFileSync(vault.htpasswd,"existing-vault-user:!\n");
  const instance=join(root,"instance.json"), selected=join(root,"selected-instance.json");
  writeFileSync(instance,JSON.stringify({applications:[{module:"another/application",export:"otherApplication",configuration:vault},application(main)]}));
  symlinkSync(instance,selected);
  const result=invoke(selected); assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(vault.htpasswd,"utf8"),"existing-vault-user:!\n");
  const identity=await createCredentials(main).authenticated(new Request(main.origin+"/-/whoami",{headers:{authorization:"Basic "+Buffer.from("publisher:fixture-publisher-password").toString("base64")}}));
  assert.equal(identity,"publisher");
  assert.ok(!result.stdout.includes("fixture-publisher-password"));
  const direct=join(root,"direct.json");writeFileSync(direct,JSON.stringify(main));
  assert.equal(invoke(direct).status,0);
});

test("missing or competing registry identities refuse before account writes", t => {
  const root=mkdtempSync(join(tmpdir(),"registry-publisher-ambiguous-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const first=configuration(join(root,"first")), second=configuration(join(root,"second"));
  for(const applications of [[],[application(first),application(second)]]) {
    const path=join(root,"instance.json");writeFileSync(path,JSON.stringify({applications}));
    const result=invoke(path);assert.notEqual(result.status,0);assert.match(result.stderr,/identify one native npm registry application/);
    assert.equal(existsSync(first.htpasswd),false);assert.equal(existsSync(second.htpasswd),false);
  }
});

test("an explicit publisher origin selects one declared registry without changing the other's account", async t => {
  const root=mkdtempSync(join(tmpdir(),"registry-publisher-origin-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const main=configuration(join(root,"main")), vault={...configuration(join(root,"vault")),
    hosts:["localhost"],origin:"http://localhost:18821"};
  const instance=join(root,"instance.json");
  writeFileSync(instance,JSON.stringify({applications:[application(main),application(vault)]}));
  for(const [chosen,other] of [[main,vault],[vault,main]]) {
    const before=existsSync(other.htpasswd)?readFileSync(other.htpasswd,"utf8"):null;
    const result=invoke(instance,["--origin",chosen.origin]);
    assert.equal(result.status,0,result.stderr);
    assert.equal(existsSync(other.htpasswd)?readFileSync(other.htpasswd,"utf8"):null,before);
    assert.equal(await createCredentials(chosen).verify("publisher","fixture-publisher-password"),"publisher");
  }
});

test("foreign or malformed publisher origins refuse before account writes", t => {
  const root=mkdtempSync(join(tmpdir(),"registry-publisher-origin-refused-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const selected=configuration(root), instance=join(root,"instance.json");
  writeFileSync(instance,JSON.stringify({applications:[application(selected)]}));
  for(const origin of ["https://foreign.example","https://registry.example.test/path","https://user:password@registry.example.test"]) {
    assert.notEqual(invoke(instance,["--origin",origin]).status,0);
    assert.equal(existsSync(selected.htpasswd),false);
  }
});
