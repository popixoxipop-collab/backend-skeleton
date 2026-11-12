import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { observeGarbagePlan } from './gc-plan.mjs';
import { makeFixture, runBaselineScenarios, FIXED_NOW } from './gc-baseline-probe.mjs';
import { collectArtifactGarbage } from '../../lib/artifact-store-next/gc.mjs';

const CLI = fileURLToPath(new URL('./gc-plan.mjs', import.meta.url));
function withFixture(fn) { const f = makeFixture(); try { return fn(f); } finally { f.close(); } }
function observe(f, opts = {}) { return observeGarbagePlan(f.root, { nowMs: FIXED_NOW, ...opts }); }

test('recorded development counterexamples reproduce the unmarked legacy prefix and explicit observation', () => {
  const report = runBaselineScenarios();
  assert.equal(report.cases.length, 11);
  assert.equal(report.legacy_completeness_fields_absent, true);
  assert.equal(report.no_file_deletion, true);
});
for (const [id, options, selected, deferred, reason] of [
  ['zero byte budget', { maxDeleteBytes: 0 }, 0, 3, 'max_delete_bytes'],
  ['smaller later blob is NOT best-fit selected', { maxDeleteBytes: 6 }, 0, 3, 'max_delete_bytes'],
  ['zero count budget', { maxDeleteCount: 0 }, 0, 3, 'max_delete_count'],
  ['one count', { maxDeleteCount: 1 }, 1, 2, 'max_delete_count'],
  ['byte prefix exactly20', { maxDeleteBytes: 20 }, 1, 2, 'max_delete_bytes'],
  ['two item prefix', { maxDeleteBytes: 25 }, 2, 1, 'max_delete_bytes'],
  ['whole inventory exactly32 bytes', { maxDeleteBytes: 32 }, 3, 0, null],
  ['whole inventory exactly3 items', { maxDeleteCount: 3 }, 3, 0, null],
]) {
  test(id, () => withFixture(f => {
    const r = observe(f, options);
    assert.equal(r.candidates.length, selected); assert.equal(r.deferred_count, deferred);
    assert.equal(r.stop_reason, reason); assert.equal(r.selection_complete, deferred === 0);
    assert.equal(r.status, deferred ? 'partial' : 'complete');
    assert.equal(r.eligible_count, 3); assert.equal(r.eligible_bytes, 32);
    assert.equal(r.candidate_bytes + r.deferred_bytes, 32);
    assert.equal(r.first_deferred?.size ?? null, deferred ? [20,5,7][selected] : null);
  }));
}
test('legacy parity across count/byte limits, protected entries and age filters', () => withFixture(f => {
  for (const maxDeleteCount of [0,1,2,3,10]) for (const maxDeleteBytes of [0,6,20,21,25,31,32,40]) {
    for (const extra of [{}, { reachable: [f.refs[0]] }, { minAgeMs: 120_000 }]) {
      const options = { nowMs: FIXED_NOW, maxDeleteCount, maxDeleteBytes, ...extra };
      const legacy = collectArtifactGarbage(f.root, options), current = observeGarbagePlan(f.root, options);
      assert.deepEqual(current.candidates, legacy.candidates);
      assert.equal(current.candidate_bytes, legacy.candidate_bytes);
      assert.equal(current.total_blobs, legacy.total_blobs);
      assert.deepEqual(current.unexpected, legacy.unexpected);
    }
  }
}));
test('empty eligible set is complete even when both limits are zero', () => withFixture(f => {
  const r = observe(f, { reachable: f.refs, maxDeleteCount: 0, maxDeleteBytes: 0 });
  assert.equal(r.status, 'complete'); assert.equal(r.stop_reason, null);
  assert.equal(r.protected_blobs, 3); assert.equal(r.eligible_count, 0);
}));
test('young blobs are not deferred; age boundary qualifies exactly', () => withFixture(f => {
  assert.equal(observe(f, { minAgeMs: 60_001 }).young_blobs, 3);
  assert.equal(observe(f, { minAgeMs: 60_000 }).eligible_count, 3);
}));
test('existing empty store is complete, but a missing caller root is an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't21-empty-'));
  try {
    const r = observeGarbagePlan(root); assert.equal(r.status, 'complete'); assert.equal(r.total_blobs, 0);
    assert.throws(() => observeGarbagePlan(path.join(root, 'missing')), /ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('malformed and symlink entries make inventory partial without being followed', () => withFixture(f => {
  const sha = path.join(f.root, 'blobs/sha256');
  fs.mkdirSync(path.join(sha, 'zz')); fs.writeFileSync(path.join(sha, 'zz/untouched'), 'KEEP');
  const link = path.join(sha, 'ab'); fs.symlinkSync(path.join(sha, 'zz'), link, 'dir');
  const r = observe(f);
  assert.equal(r.selection_complete, true); assert.equal(r.inventory_complete, false); assert.equal(r.status, 'partial');
  assert.deepEqual(r.unexpected, ['ab','zz']); assert.equal(r.total_blobs, 3);
  assert.equal(fs.readFileSync(path.join(sha, 'zz/untouched'), 'utf8'), 'KEEP');
}));
test('a symlink in the store layout is refused before any traversal', () => withFixture(f => {
  const link = path.join(f.root, 'alias'); fs.symlinkSync(f.root, link, 'dir');
  assert.throws(() => observeGarbagePlan(link), /real directories/);
}));
test('member symlinks, directories and wrong digest prefixes are never candidates', () => withFixture(f => {
  const dir = path.join(f.root, 'blobs/sha256/aa'); fs.mkdirSync(dir);
  fs.symlinkSync(f.store.pathForDigest(f.refs[0].digest), path.join(dir, 'a'.repeat(64)));
  fs.mkdirSync(path.join(dir, 'aa' + 'b'.repeat(62)));
  fs.writeFileSync(path.join(dir, 'b'.repeat(64)), 'KEEP');
  const r = observe(f); assert.equal(r.candidates.length, 3); assert.equal(r.unexpected.length, 3);
  assert.equal(r.status, 'partial');
}));
for (const name of ['maxDeleteBytes', 'maxDeleteCount', 'minAgeMs']) {
  for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    test(`invalid ${name}=${String(value)} rejected`, () => withFixture(f => {
      assert.throws(() => observe(f, { [name]: value }), /non-negative safe integer/);
    }));
  }
}
test('bad reachability, nonfinite clock and apply requests are rejected', () => withFixture(f => {
  assert.throws(() => observe(f, { reachable: ['not-sha'] }), /SHA-256/);
  assert.throws(() => observe(f, { nowMs: NaN }), /finite/);
  assert.throws(() => observe(f, { dryRun: false }), /read-only/);
}));
test('zero-size blob can fit zero byte budget without confusing count limits', () => withFixture(f => {
  const zero = f.store.put(''); fs.utimesSync(f.store.pathForDigest(zero.digest), 1, 1);
  const reachable = f.refs;
  const r = observe(f, { reachable, maxDeleteBytes: 0 });
  assert.equal(r.status, 'complete'); assert.equal(r.candidates.length, 1); assert.equal(r.candidate_bytes, 0);
  assert.equal(observe(f, { reachable, maxDeleteCount: 0 }).status, 'partial');
}));
test('observer and CLI never alter file bytes, mtimes or deletion authority', () => withFixture(f => {
  const before = f.refs.map(ref => ({ bytes: f.store.read(ref), mtime: fs.statSync(f.store.pathForDigest(ref.digest)).mtimeMs }));
  const cmd = spawnSync(process.execPath, [CLI, f.root, '--max-bytes', '6'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(cmd.status, 0, cmd.stderr);
  const r = JSON.parse(cmd.stdout); assert.equal(r.status, 'partial'); assert.equal(r.deferred_count, 3);
  assert.equal(r.deletion_authorized, false); assert.equal(r.content_integrity_verified, false); assert.deepEqual(r.deleted, []);
  assert.deepEqual(f.refs.map(ref => ({ bytes: f.store.read(ref), mtime: fs.statSync(f.store.pathForDigest(ref.digest)).mtimeMs })), before);
}));
test('CLI fails invalid or duplicate arguments rather than silently changing the budget', () => withFixture(f => {
  for (const args of [['--apply'], ['--max-bytes', '-1'], ['--max-count', '1', '--max-count', '2'], ['--max-bytes']]) {
    const r = spawnSync(process.execPath, [CLI, f.root, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 2); assert.equal(r.stdout, '');
  }
}));
