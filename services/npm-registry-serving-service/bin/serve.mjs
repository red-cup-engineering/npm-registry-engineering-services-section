#!/usr/bin/env node
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {npmRegistryApplication} from '../src/application.mjs';

const configuration=JSON.parse(await readFile(process.argv[2]??process.env.NPM_REGISTRY_CONFIGURATION,'utf8'));
const application=npmRegistryApplication({configuration});
const port=Number(process.env.NPM_REGISTRY_PORT??18821);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid registry port');
const server=createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://127.0.0.1');
  const response=await application.onRequest({req,url})??new Response('Not found',{status:404});
  res.writeHead(response.status,Object.fromEntries(response.headers));
  if(req.method==='HEAD'||!response.body)res.end();
  else Readable.fromWeb(response.body).on('error',error=>res.destroy(error)).pipe(res);
 } catch {
  if(res.headersSent)res.destroy();
  else {res.writeHead(500);res.end('Registry request failed');}
 }
});
server.listen(port,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
