import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testScript = fileURLToPath(new URL('../next/t00/met_conveyor_test.py', import.meta.url));

test('T00 MET conveyor: pinned 291 tasks, adversarial DAG, receipt and no automatic MET', () => {
  const result = spawnSync('python3', [testScript], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 3 tests/);
  assert.match(result.stderr, /OK/);
});
