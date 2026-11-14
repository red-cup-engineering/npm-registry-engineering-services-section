import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const [name, callable] of [['select-npm-registry-packages','selectNpmRegistryPackages'], ['check-npm-registry-package-installations','checkNpmRegistryPackageInstallations']]) {
  const script = fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
  function run(args, input = '') {
    const result = spawnSync(process.execPath, [script, ...args], {input, encoding:'utf8', timeout:10000});
    assert.equal(result.error, undefined, 'native command must terminate');
    return result;
  }
  test(`${name} help describes its actual callable without consuming input`, () => {
    for (const args of [['--help'],['-h']]) {
      const result = run(args, 'not JSON\n');
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(callable));
    }
  });
  test(`${name} strictly refuses unknown flags, values and positionals`, () => {
    for (const args of [['--unknown'],['--help=yes'],['unexpected'],['--','unexpected']]) {
      const result = run(args);
      assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
      assert.match(result.stderr, /ERR_PARSE_ARGS/u);
    }
  });
  test(`${name} preserves empty JSONL and refuses malformed requests before effects`, () => {
    const empty = run([]); assert.equal(empty.status, 0, empty.stderr); assert.equal(empty.stdout, '');
    const invalid = run([], '{}\n'); assert.notEqual(invalid.status, 0); assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /request|exactly/iu);
  });
}
