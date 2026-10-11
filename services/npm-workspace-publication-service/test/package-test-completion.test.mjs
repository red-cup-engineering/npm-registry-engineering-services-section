import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testSummaryOrRefuse } from '../scripts/publish-package.mjs';

for (const exitCode of [0, 7]) test(`publication requires command completion after a passing test summary: exit ${exitCode}`, async () => {
 const root=await mkdtemp(join(tmpdir(),'publication-test-completion-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({scripts:{test:'node check.cjs'}}));
  await writeFile(join(root,'check.cjs'),`console.log('# tests 1\n# pass 1\n# fail 0');process.exitCode=${exitCode};`.replaceAll('\n','\\n'));
  if (exitCode===0) assert.equal((await testSummaryOrRefuse(2,root)).fail,0);
  else await assert.rejects(testSummaryOrRefuse(2,root),error=>error.step===2 && error.evidence.exitCode===7 && error.evidence.fail===0);
 } finally { await rm(root,{recursive:true,force:true}); }
});
