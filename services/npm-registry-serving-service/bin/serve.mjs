#!/usr/bin/env node
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {npmRegistryApplication} from '../src/application.mjs';

const configuration=JSON.parse(await readFile(process.argv[2]??process.env.NPM_REGISTRY_CONFIGURATION,'utf8'));
// Serving performs no store-wide startup maintenance by default. The original
// receive-store CLI owns explicit reconciliation and public leftover removal.
const application=npmRegistryApplication({configuration});
const port=Number(process.env.NPM_REGISTRY_PORT??18821);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid registry port');
// NPM_REGISTRY_ACCESS_LOG=1: one JSON line per answered request on stderr (method, path, status, conditional).
const accessLog=process.env.NPM_REGISTRY_ACCESS_LOG==='1';
// Metadata is JSON and compresses to a fraction; npm and pnpm ask for gzip. Tarballs are gzip already.
const compressible=(req,response)=>/\bgzip\b/u.test(req.headers['accept-encoding']??'')&&/json/u.test(response.headers.get('content-type')??'');
const server=createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://127.0.0.1');
  const response=await application.onRequest({req,url})??new Response('Not found',{status:404});
  const headers=Object.fromEntries(response.headers);
  const gzip=req.method!=='HEAD'&&response.body&&compressible(req,response);
  if(response.headers.has('etag')||gzip)headers.vary=[headers.vary,'Accept-Encoding'].filter(Boolean).join(', ');
  if(gzip){delete headers['content-length'];headers['content-encoding']='gzip';}
  res.writeHead(response.status,headers);
  if(accessLog)process.stderr.write(`${JSON.stringify({method:req.method,path:url.pathname,status:response.status,...(req.headers['if-none-match']?{ifNoneMatch:true}:{}),...(gzip?{gzip:true}:{})})}\n`);
  if(req.method==='HEAD'||!response.body){res.end();return;}
  const body=Readable.fromWeb(response.body);
  await (gzip?pipeline(body,createGzip(),res):pipeline(body,res));
 } catch {
  if(res.headersSent)res.destroy();
  else {res.writeHead(500);res.end('Registry request failed');}
 }
});
server.listen(port,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
