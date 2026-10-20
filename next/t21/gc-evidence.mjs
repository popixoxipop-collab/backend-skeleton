// Fixed-source evidence validator; never executes commands supplied by a record.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const SOURCE_COMMIT = '5d6766234142cf7be6dbf4b0baf704c7c2e9ea2a';
export const SOURCE_TREE = '8237a3a9a36485efdc4681941064d060faccbedd';
export const SOURCE_PATHS = Object.freeze([
  'lib/artifact-store-next/gc.mjs',
  'lib/artifact-store-next/store.mjs',
  'lib/scan-scheduler-next/BASELINE.json',
  'next/t21/GC_BASELINE_SUPPLEMENT.md',
  'next/t21/gc-baseline-probe.mjs',
  'next/t21/gc-plan.mjs',
  'next/t21/gc-plan.test.mjs',
  'test/t21-gc-plan.test.mjs',
]);
const COUNTS = Object.freeze({ tests: 35, pass: 35, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');

export function verifyGarbageEvidence(record, { pinned, current, probeBytes, testBytes, replayed }) {
  const problems = [];
  const check = (label, fn) => { try { fn(); } catch { problems.push(label); } };
  check('record identity or authority mismatch', () => {
    assert.equal(record.schema, 't21.gc-exact-baseline-record/1');
    assert.equal(record.source_commit, SOURCE_COMMIT); assert.equal(record.source_tree, SOURCE_TREE);
    assert.equal(record.deletion_performed, false); assert.equal(record.release_authorized, false);
    assert.ok(Array.isArray(record.limits) && record.limits.length >= 5);
  });
  check('source inventory mismatch', () => {
    assert.deepEqual(record.source_files.map(x => x.path).sort(), SOURCE_PATHS);
    assert.deepEqual([...pinned.keys()].sort(), SOURCE_PATHS);
    assert.deepEqual([...current.keys()].sort(), SOURCE_PATHS);
    for (const item of record.source_files) {
      const expected = pinned.get(item.path), actual = current.get(item.path);
      assert.ok(Buffer.isBuffer(expected) && Buffer.isBuffer(actual));
      assert.equal(item.size, expected.length); assert.equal(item.sha256, hash(expected));
      assert.equal(item.git_blob_sha1, blob(expected)); assert.deepEqual(actual, expected);
    }
  });
  check('command or transcript mismatch', () => {
    assert.deepEqual(record.commands.map(x => x.name), ['probe','tests']);
    const [probe, tests] = record.commands;
    assert.deepEqual(probe.argv, [record.environment.node_executable, 'next/t21/gc-baseline-probe.mjs']);
    assert.deepEqual(tests.argv, [record.environment.node_executable, '--test', '--test-concurrency=1', '--test-reporter=tap', 'test/t21-gc-plan.test.mjs']);
    for (const command of record.commands) {
      assert.equal(command.exit_code, 0); assert.equal(command.stderr_sha256, hash(Buffer.alloc(0)));
    }
    assert.equal(probe.stdout_sha256, hash(probeBytes)); assert.equal(tests.stdout_sha256, hash(testBytes));
    assert.deepEqual(probe.counts, {}); assert.deepEqual(tests.counts, COUNTS);
    const found = {};
    for (const [_, key, value] of testBytes.toString('utf8').matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) {
      assert.ok(!Object.hasOwn(found, key)); found[key] = Number(value);
    }
    assert.deepEqual(found, COUNTS);
  });
  check('scenario replay mismatch', () => {
    const recorded = JSON.parse(probeBytes.toString('utf8'));
    assert.equal(recorded.schema, 't21.gc-baseline-supplement/1');
    assert.equal(recorded.cases.length, 11); assert.equal(recorded.legacy_completeness_fields_absent, true);
    assert.equal(recorded.no_file_deletion, true); assert.deepEqual(recorded, replayed);
  });
  return problems;
}
