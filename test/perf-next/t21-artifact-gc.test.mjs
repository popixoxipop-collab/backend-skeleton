import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';
import { collectArtifactGarbage } from '../../lib/artifact-store-next/gc.mjs';

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-gc-')); }

test('artifact GC defaults to dry-run and never selects reachable blobs', () => {
	const root = scratch();
	const store = createArtifactStore(root);
	const keep = store.put('keep');
	const drop = store.put('drop');
	const result = collectArtifactGarbage(root, { reachable: [keep], nowMs: Date.now() + 10_000 });
	assert.equal(result.dry_run, true);
	assert.deepEqual(result.candidates.map((x) => x.digest), [drop.digest]);
	assert.equal(store.has(keep), true);
	assert.equal(store.has(drop), true);
});

test('artifact GC apply deletes only unreachable age-qualified blobs', () => {
	const root = scratch();
	const store = createArtifactStore(root);
	const keep = store.put('keep');
	const drop = store.put('drop');
	const fresh = store.put('fresh');
	const now = Date.now() + 20_000;
	fs.utimesSync(store.pathForDigest(fresh.digest), new Date(now), new Date(now));
	const result = collectArtifactGarbage(root, { reachable: [keep.digest], dryRun: false, minAgeMs: 5_000, nowMs: now });
	assert.deepEqual(result.deleted.map((x) => x.digest), [drop.digest]);
	assert.equal(store.has(keep), true);
	assert.equal(store.has(drop), false);
	assert.equal(store.has(fresh), true);
});

test('artifact GC reports malformed entries but refuses to delete them automatically', () => {
	const root = scratch();
	const store = createArtifactStore(root);
	store.put('valid');
	const odd = path.join(root, 'blobs', 'sha256', 'zz');
	fs.mkdirSync(odd, { recursive: true });
	fs.writeFileSync(path.join(odd, 'not-a-digest'), 'do not touch');
	const result = collectArtifactGarbage(root, { dryRun: false, nowMs: Date.now() + 10_000 });
	assert.ok(result.unexpected.includes('zz'));
	assert.equal(fs.existsSync(path.join(odd, 'not-a-digest')), true);
});

test('artifact GC deletion budgets bound destructive work', () => {
	const root = scratch();
	const store = createArtifactStore(root);
	store.put('a');
	store.put('bb');
	store.put('ccc');
	const result = collectArtifactGarbage(root, { maxDeleteCount: 1, maxDeleteBytes: 1024, nowMs: Date.now() + 10_000 });
	assert.equal(result.candidates.length, 1);
});
