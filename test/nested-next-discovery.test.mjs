import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUITES, inspectSuite } from '../scripts/run-next-nested-tests.mjs';

test('nested suite registry uses unique track ids and nested test namespaces', () => {
  assert.equal(new Set(SUITES.map((suite) => suite.id)).size, SUITES.length);
  for (const suite of SUITES) {
    assert.match(suite.id, /^T\d{2}$/);
    assert.ok(suite.testDir.startsWith('test/'));
    assert.ok(suite.sourcePaths.length > 0);
  }
});

test('nested suite inspection is absent-safe but fails closed once source appears', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-nested-suite-'));
  const suite = { id: 'T99', sourcePaths: ['lib/example-next'], testDir: 'test/example-next' };
  try {
    assert.deepEqual(inspectSuite(suite, root), { id: 'T99', status: 'NOT_PRESENT', tests: [] });

    fs.mkdirSync(path.join(root, 'lib/example-next'), { recursive: true });
    assert.deepEqual(inspectSuite(suite, root), { id: 'T99', status: 'FAIL_MISSING_TESTS', tests: [] });

    fs.mkdirSync(path.join(root, 'test/example-next'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test/example-next/example.test.mjs'), 'export {};\n');
    const ready = inspectSuite(suite, root);
    assert.equal(ready.status, 'READY');
    assert.equal(ready.tests.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
