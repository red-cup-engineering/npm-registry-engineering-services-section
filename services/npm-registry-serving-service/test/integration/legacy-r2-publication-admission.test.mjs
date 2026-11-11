import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCli = process.env.LEGACY_R2_PUBLICATION_CLI;
if (!originalCli) throw new Error('Select the exact source-qualified original legacy CLI with LEGACY_R2_PUBLICATION_CLI');
test('legacy source fabrication refuses absent and forged admission before any materialization or child', () => {
  const root = mkdtempSync(join(tmpdir(), 'r2-source-admission-'));
  try {
    const bin = join(root, 'bin'), work = join(root, 'work'), calls = join(root, 'child-calls');
    mkdirSync(bin); mkdirSync(work);
    const fixture = join(root, 'owner-input.json');
    writeFileSync(fixture, 'original owner bytes\n');
    for (const program of ['sh', 'curl', 'npm'])
      writeFileSync(join(bin, program), '#!/bin/sh\nprintf "child-called\\n" >> "$CALL_LOG"\nexit 0\n', { mode: 0o755 });
    for (const forged of [false, true]) {
      const env = { PATH: bin, TMPDIR: work, HOME: root, CALL_LOG: calls, NODE_DISABLE_COMPILE_CACHE: '1' };
      if (forged) env.PHYSICAL_100GB_PRODUCER_CUSTODY_ADMISSION = 'yes';
      const started = Date.now();
      let refusal;
      try { execFileSync(process.execPath, [originalCli, join(root, 'absent-declaration.json')], {
        cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'],
      }); } catch (error) { refusal = error; }
      assert.ok(refusal, 'unqualified source fabrication must refuse');
      assert.equal(refusal.status, 1);
      assert.match(refusal.stderr, /R2_SOURCE_FABRICATION_ADMISSION_REQUIRED/);
      assert.ok(Date.now() - started < 5000, 'admission precedes repository work');
      assert.equal(existsSync(calls), false);
      assert.deepEqual(readdirSync(work), []);
      assert.equal(readFileSync(fixture, 'utf8'), 'original owner bytes\n');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
