#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, resolve} from 'node:path';
import {admittedConfiguration} from '../src/application.mjs';
import {receiveStore} from '../src/reception.mjs';
import {createNpmRegistry} from '../src/registry.mjs';
import {removePublicLeftovers} from '../src/leftovers.mjs';

// receive-registry-store CONFIGURATION [--dry-run]
// Receive every package the configured store still holds in the earlier layout as facts, and reconcile every
// package's earlier-layout projection with its facts. With --dry-run nothing is written: each package is read,
// its tarballs measured, and its projection compared with what the earlier store served. Prints the summary; exits
// 1 when any package would not be received.
const [path,...flags]=process.argv.slice(2);
if(!path||flags.some(flag=>!['--dry-run','--remove-public-leftovers'].includes(flag)))throw new TypeError('usage: receive-registry-store CONFIGURATION [--dry-run] [--remove-public-leftovers]');
if(flags.includes('--dry-run')&&flags.includes('--remove-public-leftovers'))throw new TypeError('public leftover removal is an explicit write, separate from dry-run receiving');
const configuration=admittedConfiguration(JSON.parse(await readFile(path,'utf8')));
const home=value=>value===undefined||isAbsolute(value)?value:resolve(homedir(),value);
if(flags.includes('--remove-public-leftovers'))
  process.stdout.write(JSON.stringify(await removePublicLeftovers({configuration,storage:home(configuration.storage)}))+'\n');
const registry=createNpmRegistry({storage:home(configuration.storage),htpasswd:home(configuration.htpasswd),origin:configuration.origin,privateScopes:configuration.privateScopes,privateNames:configuration.privateNames});
const summary=await receiveStore(registry.store,{origin:registry.origin,admits:registry.isPrivate,dryRun:flags.includes('--dry-run')});
process.stdout.write(`${JSON.stringify(summary,null,2)}\n`);
process.exitCode=summary.refused.length>0?1:0;
