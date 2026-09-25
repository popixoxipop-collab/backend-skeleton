import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-artifacts-')); }

test('artifact store deduplicates by exact bytes and verifies reads', () => {
	const store = createArtifactStore(scratch());
	const first = store.put('same bytes');
	const second = store.put(Buffer.from('same bytes'));
	assert.deepEqual(first, second);
	assert.equal(store.read(first).toString('utf8'), 'same bytes');
	assert.equal(store.has(first), true);
});

test('artifact store detects corruption instead of returning poisoned cache data', () => {
	const store = createArtifactStore(scratch());
	const ref = store.put('trusted bytes');
	fs.writeFileSync(store.pathForDigest(ref.digest), 'tampered');
	assert.throws(() => store.read(ref), (error) => error.code === 'ARTIFACT_CORRUPT');
});

test('artifact byte budget is enforced before write', () => {
	const store = createArtifactStore(scratch(), { maxArtifactBytes: 4 });
	assert.throws(() => store.put('12345'), (error) => error.code === 'ARTIFACT_BUDGET_EXCEEDED');
});
