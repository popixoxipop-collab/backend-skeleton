import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';
import { createCacheIndex } from '../../lib/artifact-store-next/cache-index.mjs';
import { digestJson } from '../../lib/scan-scheduler-next/cache-key.mjs';
import { runCachedTask } from '../../lib/scan-scheduler-next/cache-runtime.mjs';

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-cache-runtime-')); }

function fixture() {
	const root = scratch();
	return {
		root,
		store: createArtifactStore(path.join(root, '.sbf', 'cache-next', 'artifacts')),
		index: createCacheIndex(root),
	};
}

test('cache miss computes once and subsequent hit returns identical semantic value', async () => {
	const { store, index } = fixture();
	const key = digestJson({ source: 'v1', parser: 'p1' });
	let calls = 0;
	const compute = async () => ({ z: 2, a: ['stable', 1], nested: { y: true, x: null } });
	const first = await runCachedTask({ cacheKey: key, cacheIndex: index, artifactStore: store, compute: async () => { calls += 1; return compute(); }, dependencies: ['src/a.js'] });
	const second = await runCachedTask({ cacheKey: key, cacheIndex: index, artifactStore: store, compute: async () => { calls += 1; return compute(); }, dependencies: ['src/a.js'] });
	assert.equal(first.cache_hit, false);
	assert.equal(second.cache_hit, true);
	assert.equal(calls, 1);
	assert.deepEqual(second.value, first.value);
	assert.deepEqual(second.artifact, first.artifact);
});

test('changing cache key forces recomputation instead of returning old bytes', async () => {
	const { store, index } = fixture();
	let calls = 0;
	for (const source of ['v1', 'v2']) {
		const key = digestJson({ source, parser: 'p1' });
		const result = await runCachedTask({ cacheKey: key, cacheIndex: index, artifactStore: store, compute: async () => ({ source, call: ++calls }) });
		assert.equal(result.cache_hit, false);
	}
	assert.equal(calls, 2);
});

test('corrupt cached artifact fails closed and never invokes compute as a hidden repair', async () => {
	const { store, index } = fixture();
	const key = digestJson({ source: 'v1' });
	const first = await runCachedTask({ cacheKey: key, cacheIndex: index, artifactStore: store, compute: async () => ({ ok: true }) });
	fs.writeFileSync(store.pathForDigest(first.artifact.digest), 'tampered');
	let called = false;
	await assert.rejects(
		runCachedTask({ cacheKey: key, cacheIndex: index, artifactStore: store, compute: async () => { called = true; return { ok: true }; } }),
		(error) => error.code === 'ARTIFACT_CORRUPT',
	);
	assert.equal(called, false);
});

test('validation executes on both misses and hits so cache never bypasses caller invariants', async () => {
	const { store, index } = fixture();
	const key = digestJson({ validation: 1 });
	const seen = [];
	for (let i = 0; i < 2; i++) {
		await runCachedTask({
			cacheKey: key,
			cacheIndex: index,
			artifactStore: store,
			compute: async () => ({ ok: true }),
			validate: async (value, ctx) => { assert.equal(value.ok, true); seen.push(ctx.cache_hit); },
		});
	}
	assert.deepEqual(seen, [false, true]);
});
