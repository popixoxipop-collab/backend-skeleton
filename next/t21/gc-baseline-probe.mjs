// Development fixtures only. No caller-supplied store is opened or deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';
import { collectArtifactGarbage } from '../../lib/artifact-store-next/gc.mjs';
import { observeGarbagePlan } from './gc-plan.mjs';

export const FIXED_NOW = 1_600_000_000_000;
export function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't21-observed-plan-'));
  try {
    const store = createArtifactStore(root);
    const refs = ['c'.repeat(20), 'small', '1234567'].map(value => store.put(value));
    assert.deepEqual([...refs].sort((a,b) => a.digest.localeCompare(b.digest)).map(x => x.size), [20,5,7]);
    for (const ref of refs) fs.utimesSync(store.pathForDigest(ref.digest), (FIXED_NOW - 60_000)/1000, (FIXED_NOW - 60_000)/1000);
    return { root, store, refs, close: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
export function runBaselineScenarios() {
  const fixture = makeFixture();
  try {
    const { root, refs } = fixture;
    const cases = [
      ['uncapped', {}, 3, 32, 'complete', null],
      ['zero-bytes', { maxDeleteBytes: 0 }, 0, 0, 'partial', 'max_delete_bytes'],
      ['oversized-first-smaller-later', { maxDeleteBytes: 6 }, 0, 0, 'partial', 'max_delete_bytes'],
      ['zero-count', { maxDeleteCount: 0 }, 0, 0, 'partial', 'max_delete_count'],
      ['one-count', { maxDeleteCount: 1 }, 1, 20, 'partial', 'max_delete_count'],
      ['twenty-bytes', { maxDeleteBytes: 20 }, 1, 20, 'partial', 'max_delete_bytes'],
      ['exact-final-byte-boundary', { maxDeleteBytes: 32 }, 3, 32, 'complete', null],
      ['exact-final-count-boundary', { maxDeleteCount: 3 }, 3, 32, 'complete', null],
      ['protected-first', { reachable: [refs[0]], maxDeleteBytes: 6 }, 1, 5, 'partial', 'max_delete_bytes'],
      ['all-protected-zero-budget', { reachable: refs, maxDeleteCount: 0, maxDeleteBytes: 0 }, 0, 0, 'complete', null],
      ['all-young-zero-budget', { minAgeMs: 120_000, maxDeleteCount: 0 }, 0, 0, 'complete', null],
    ];
    const observations = cases.map(([id, opts, count, bytes, status, reason]) => {
      const options = { nowMs: FIXED_NOW, ...opts };
      const legacy = collectArtifactGarbage(root, options);
      const observed = observeGarbagePlan(root, options);
      assert.deepEqual(observed.candidates, legacy.candidates);
      assert.equal(observed.candidate_bytes, legacy.candidate_bytes);
      assert.equal(observed.total_blobs, legacy.total_blobs);
      assert.equal(observed.candidates.length, count);
      assert.equal(observed.candidate_bytes, bytes);
      assert.equal(observed.status, status);
      assert.equal(observed.stop_reason, reason);
      assert.equal(observed.deferred_count, observed.eligible_count - count);
      assert.equal(observed.deferred_bytes, observed.eligible_bytes - bytes);
      assert.deepEqual(legacy.deleted, []); assert.deepEqual(observed.deleted, []);
      return { id, options, legacy, observed };
    });
    for (const ref of refs) assert.equal(fixture.store.has(ref), true);
    return { schema: 't21.gc-baseline-supplement/1', fixture_sizes_in_digest_order: [20,5,7],
      fixture_kind: 'development-only', cases: observations, no_file_deletion: true,
      legacy_completeness_fields_absent: ['status','selection_complete','stop_reason'].every(key => !Object.hasOwn(observations[0].legacy, key)) };
  } finally { fixture.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(runBaselineScenarios(), null, 2));
}
