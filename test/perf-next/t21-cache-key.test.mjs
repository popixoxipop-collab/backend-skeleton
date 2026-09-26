import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanCacheKey, digestJson, stableJson } from '../../lib/scan-scheduler-next/cache-key.mjs';

function dimensions() {
	const d = (x) => digestJson({ value: x });
	return {
		sourceDigest: d('source'),
		resolverDigest: d('resolver'),
		configDigest: d('config'),
		parserDigest: d('parser'),
		adapterDigest: d('adapter'),
		schemaDigest: d('schema'),
		policyDigest: d('policy'),
		runtimeFingerprint: 'node=22;platform=test',
	};
}

test('cache key is deterministic across object key order', () => {
	assert.equal(stableJson({ b: 2, a: { y: 2, x: 1 } }), stableJson({ a: { x: 1, y: 2 }, b: 2 }));
	assert.deepEqual(buildScanCacheKey(dimensions()), buildScanCacheKey({ ...dimensions() }));
});

test('every semantic dimension invalidates the cache key', () => {
	const base = dimensions();
	const baseline = buildScanCacheKey(base).digest;
	for (const key of Object.keys(base)) {
		const changed = { ...base };
		changed[key] = key === 'runtimeFingerprint' ? 'node=23;platform=test' : digestJson({ changed: key });
		assert.notEqual(buildScanCacheKey(changed).digest, baseline, `${key} did not invalidate cache key`);
	}
});

test('cache key rejects malformed digests and ambiguous JSON material', () => {
	assert.throws(() => buildScanCacheKey({ ...dimensions(), sourceDigest: 'abc' }), /sourceDigest/);
	assert.throws(() => stableJson({ bad: undefined }), /unsupported cache-key material/);
	assert.throws(() => stableJson({ bad: Number.NaN }), /non-finite/);
});
