import assert from "node:assert/strict";
import { test } from "node:test";
import fsPromises, { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { publishBody, registryFixture } from "./support/registry.mjs";
import { packagedVersion } from "./support/tarball.mjs";
import { boundedMetadata } from "../src/metadata-cache.mjs";
import { createNpmRegistry } from "../src/registry.mjs";

const name = "@registry-fixture/capability";

test("a publish over the byte cap is refused 413 and stores nothing, whether or not it declares its length", async (t) => {
  const f = await registryFixture(t, { maxPublishBytes: 128 });
  const body = publishBody(packagedVersion(name, "1.0.0"), { origin: f.origin });
  assert.equal((await f.put(name, body)).status, 413);
  const chunked = await f.request(`/${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json", authorization: (await import("./support/registry.mjs")).authorization }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(body))); c.close(); } }), duplex: "half" });
  assert.equal(chunked.status, 413, "a stream with no length is counted as it is read");
  assert.equal((await f.request(`/${encodeURIComponent(name)}`)).status, 404);
});

test("while the heap is near its limit a publish waits with 503 and Retry-After, and succeeds when it is not", async (t) => {
  let pressure = true;
  const f = await registryFixture(t, { heapPressure: () => pressure });
  const response = await f.publish(packagedVersion(name, "1.0.0"));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  pressure = false;
  assert.equal((await f.publish(packagedVersion(name, "1.0.0"))).status, 201);
});

test("a stored tarball is streamed from disk with its length, and its bytes are those published", async (t) => {
  const f = await registryFixture(t);
  const bytes = packagedVersion(name, "1.0.0");
  assert.equal((await f.publish(bytes)).status, 201);
  const response = await f.request(`/${encodeURIComponent(name)}/-/capability-1.0.0.tgz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(bytes.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await f.request(`/${encodeURIComponent(name)}/-/capability-9.9.9.tgz`)).status, 404);
});

test("publishes are taken one at a time, so only one body is in memory", async (t) => {
  const f = await registryFixture(t);
  const [a, b] = await Promise.all([f.publish(packagedVersion(name, "1.0.0")), f.publish(packagedVersion(name, "1.1.0"))]);
  assert.deepEqual([a.status, b.status], [201, 201]);
  const packument = await (await f.request(`/${encodeURIComponent(name)}`)).json();
  assert.deepEqual(Object.keys(packument.versions).sort(), ["1.0.0", "1.1.0"]);
});


test("metadata growth evicts the least recent view, including an oversized newest entry and a zero budget", () => {
  const cache = boundedMetadata(10);
  cache.set("older", {name:"older"}, 4);
  const current = {name:"current"};
  cache.set("current", current, 4);
  assert.equal(cache.get("current"), current);
  cache.weigh("current", 4);
  assert.equal(cache.get("older"), undefined, "growth must evict the least recent entry");
  assert.equal(cache.get("current"), current);
  cache.weigh("current", 3);
  assert.equal(cache.get("current"), undefined, "an entry cannot protect itself above budget");
  cache.set("oversized", current, 11);
  assert.equal(cache.get("oversized"), undefined);
  const off = boundedMetadata(0);
  off.set("uncached", current, 1);
  assert.equal(off.get("uncached"), undefined);
  cache.set("again", current, 5); cache.clear();
  assert.equal(cache.get("again"), undefined);
});

function publicMetadata() {
  return {name:"public-cache-fixture", description:"évidence ".repeat(20), "dist-tags":{latest:"1.0.0"},
    versions:{"1.0.0":{name:"public-cache-fixture",version:"1.0.0",dist:{tarball:"https://uplink.invalid/a.tgz"}}}};
}

test("a public response still serves correctly when its metadata cannot fit or caching is disabled", async t => {
  const metadata = publicMetadata(), raw = JSON.stringify(metadata);
  for (const budget of [0, Buffer.byteLength(raw,"utf8")-1]) {
    let fetches = 0;
    const f = await registryFixture(t, {publicMetadataBytes:budget, fetch:async()=>{fetches++; return Response.json(metadata);}});
    const first = await f.request("/public-cache-fixture");
    assert.equal(first.status,200);
    const body = await first.text();
    assert.equal((await f.request("/public-cache-fixture")).status,200);
    assert.equal(fetches,2,"oversized metadata must be served without being retained");
    assert.equal(JSON.parse(body).description,metadata.description);
  }
});

test("public rendered representations count against the packument's budget", async t => {
  const metadata=publicMetadata(), original=JSON.stringify(metadata);
  const presented={...metadata,versions:{"1.0.0":{...metadata.versions["1.0.0"],dist:{tarball:"http://registry.invalid/public-cache-fixture/-/a.tgz"}}}};
  const budget=Buffer.byteLength(original,"utf8")+Buffer.byteLength(JSON.stringify(presented),"utf8")-1;
  let fetches=0;
  const f=await registryFixture(t,{publicMetadataBytes:budget,fetch:async()=>{fetches++;return Response.json(metadata);}});
  const first=await f.request("/public-cache-fixture"), body=await first.text();
  const second=await f.request("/public-cache-fixture");
  assert.equal(await second.text(),body);
  assert.equal(second.headers.get("etag"),first.headers.get("etag"));
  assert.equal(fetches,2,"rendering beyond the combined budget must release the packument and its rendered views");
});

test("a pressure refusal releases rebuildable metadata and reads do not refill it until the same guard clears", async t => {
  let pressure=false, fetches=0;
  const metadata=publicMetadata();
  const f=await registryFixture(t,{heapPressure:()=>pressure,fetch:async()=>{fetches++;return Response.json(metadata);}});
  const older=packagedVersion(name,"0.9.0");
  assert.equal((await f.publish(older)).status,201);
  const journal=join(f.storage,name,"facts.jsonl"), before=await readFile(journal);
  const original=await (await f.request("/public-cache-fixture")).text();
  await f.request("/public-cache-fixture"); assert.equal(fetches,1);
  pressure=true;
  const refused=await f.publish(packagedVersion(name,"1.0.0"));
  assert.equal(refused.status,503); assert.equal(refused.headers.get("retry-after"),"30");
  assert.equal((await f.publish(packagedVersion(name,"1.0.0"))).status,503,"reclamation does not bypass a still-true guard");
  assert.deepEqual(await readFile(journal),before,"reclaiming metadata must not alter existing facts");
  const held=await (await f.request(`/${encodeURIComponent(name)}`)).json();
  assert.deepEqual(Object.keys(held.versions),["0.9.0"]);
  const tarball=await f.request(`/${encodeURIComponent(name)}/-/capability-0.9.0.tgz`);
  assert.deepEqual(Buffer.from(await tarball.arrayBuffer()),older,"stored artifacts survive cache reclamation");
  for (let i=0;i<2;i++) assert.equal(await (await f.request("/public-cache-fixture")).text(),original);
  assert.equal(fetches,3,"pressure must release the old cache and refuse retention of newly read metadata");
  pressure=false;
  await f.request("/public-cache-fixture"); await f.request("/public-cache-fixture");
  assert.equal(fetches,4,"ordinary caching resumes after the unchanged pressure guard clears");
  assert.equal((await f.publish(packagedVersion(name,"1.0.0"))).status,201);
  assert.deepEqual(Object.keys((await (await f.request(`/${encodeURIComponent(name)}`)).json()).versions),["0.9.0","1.0.0"]);
});


test("house consumers charge actual facts, rendered views and search entries to the same budget", async t => {
  const f=await registryFixture(t);
  assert.equal((await f.publish(packagedVersion(name,"1.0.0",{manifest:{description:"rétenu ".repeat(400)}}))).status,201);
  const journal=join(f.storage,name,"facts.jsonl"), before=await readFile(journal);
  const rows=before.toString("utf8").trim().split("\n").map(line=>JSON.parse(line));
  const factsBytes=Buffer.byteLength(JSON.stringify(rows),"utf8");
  assert.ok(factsBytes>rows.length*512,"fixture must distinguish real material from the old per-row guess");
  const full=await (await f.request(`/${encodeURIComponent(name)}`)).text();
  const entry=(await (await f.request("/-/v1/search?text=capability")).json()).objects[0].package;
  const originalRead=fsPromises.readFile;
  let reads=0;
  const observed=t.mock.method(fsPromises,"readFile",async function(file,...args){
    if(String(file)===journal) reads++;
    return Reflect.apply(originalRead,this,[file,...args]);
  });
  syncBuiltinESMExports();
  t.after(()=>{observed.mock.restore();syncBuiltinESMExports();});
  const handler=budget=>createNpmRegistry({storage:f.storage,origin:f.origin,privateScopes:["@registry-fixture"],houseMetadataBytes:budget});
  const request=(registry,suffix)=>registry.handle(new Request(f.origin+suffix));
  const version=`/${encodeURIComponent(name)}/1.0.0`, packument=`/${encodeURIComponent(name)}`;

  const factsOnly=handler(factsBytes-1);
  await request(factsOnly,version); await request(factsOnly,version);
  assert.equal(reads,2,"actual facts exceeding budget must not stay cached on version-only reads");

  reads=0;
  const representation=handler(factsBytes+Buffer.byteLength(full,"utf8")-1);
  assert.equal(await (await request(representation,packument)).text(),full);
  assert.equal(await (await request(representation,packument)).text(),full);
  assert.equal(reads,2,"a rendered house representation growing beyond budget must release its view");

  reads=0;
  const search=handler(factsBytes+Buffer.byteLength(JSON.stringify(entry),"utf8")-1);
  assert.equal((await request(search,"/-/v1/search?text=capability")).status,200);
  await request(search,version);
  assert.equal(reads,2,"cached search entries must participate in the house view budget");
  observed.mock.restore(); syncBuiltinESMExports();
  assert.deepEqual(await readFile(journal),before,"cache eviction/readback never rewrites package facts");
});
