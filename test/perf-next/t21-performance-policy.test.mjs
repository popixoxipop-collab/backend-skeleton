import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMemoryAdmission } from '../../lib/scan-scheduler-next/resource-budget.mjs';
import { evaluatePerformanceGate } from '../../lib/scan-scheduler-next/performance-policy.mjs';

const GiB = 1024 * 1024 * 1024;

function doc(overrides = {}) {
	return {
		environment: { profile_id: 'linux-node22', platform: 'linux', arch: 'x64', node_major: 22 },
		workloads: [{
			id: '10k',
			samples: 10,
			cold_p95_ms: 100,
			peak_rss_bytes: 1000,
			cache_hit_p95_ms: 30,
			semantic_equivalence: true,
		}],
		...overrides,
	};
}

test('memory admission preserves the larger of percentage and minimum reserve', () => {
	const result = deriveMemoryAdmission({ totalBytes: 64 * GiB, reserveFraction: 0.25, minReserveBytes: 8 * GiB });
	assert.equal(result.status, 'ready');
	assert.equal(result.required_reserve_bytes, 16 * GiB);
	assert.equal(result.admission_bytes, 48 * GiB);
});

test('memory admission fails closed when the required reserve consumes the whole limit', () => {
	const result = deriveMemoryAdmission({ totalBytes: 4 * GiB, minReserveBytes: 8 * GiB });
	assert.equal(result.status, 'blocked');
	assert.equal(result.admission_bytes, 0);
	assert.equal(result.reason, 'INSUFFICIENT_MEMORY_AFTER_RESERVE');
});

test('memory admission honors an explicit smaller hard cap', () => {
	const result = deriveMemoryAdmission({ totalBytes: 64 * GiB, minReserveBytes: 8 * GiB, maxAdmissionBytes: 12 * GiB });
	assert.equal(result.admission_bytes, 12 * GiB);
});

test('performance gate passes only comparable, sufficiently sampled, semantically equivalent measurements', () => {
	const baseline = doc();
	const candidate = doc({ workloads: [{ id: '10k', samples: 10, cold_p95_ms: 108, peak_rss_bytes: 1090, cache_hit_p95_ms: 40, semantic_equivalence: true }] });
	const result = evaluatePerformanceGate({ baseline, candidate, policy: { maxCacheHitFractionOfCold: 0.5 } });
	assert.equal(result.status, 'pass');
	assert.ok(result.checks.every((x) => x.status === 'pass'));
});

test('performance gate blocks environment mismatch instead of comparing unrelated numbers', () => {
	const candidate = doc({ environment: { profile_id: 'mac-node22', platform: 'darwin', arch: 'arm64', node_major: 22 } });
	const result = evaluatePerformanceGate({ baseline: doc(), candidate });
	assert.equal(result.status, 'blocked');
	assert.equal(result.checks[0].code, 'ENVIRONMENT_MISMATCH');
});

test('performance gate blocks insufficient samples and unproven semantic equivalence', () => {
	const tooFew = doc({ workloads: [{ id: '10k', samples: 2, cold_p95_ms: 90, peak_rss_bytes: 900, cache_hit_p95_ms: 20, semantic_equivalence: true }] });
	assert.equal(evaluatePerformanceGate({ baseline: doc(), candidate: tooFew }).status, 'blocked');
	const unknown = doc({ workloads: [{ id: '10k', samples: 10, cold_p95_ms: 90, peak_rss_bytes: 900, cache_hit_p95_ms: 20 }] });
	const result = evaluatePerformanceGate({ baseline: doc(), candidate: unknown });
	assert.equal(result.status, 'blocked');
	assert.equal(result.checks[0].code, 'SEMANTIC_EQUIVALENCE_UNPROVEN');
});

test('performance gate fails semantic mismatch even when candidate is faster', () => {
	const candidate = doc({ workloads: [{ id: '10k', samples: 10, cold_p95_ms: 1, peak_rss_bytes: 1, cache_hit_p95_ms: 1, semantic_equivalence: false }] });
	const result = evaluatePerformanceGate({ baseline: doc(), candidate });
	assert.equal(result.status, 'fail');
	assert.equal(result.checks[0].code, 'SEMANTIC_MISMATCH');
});

test('performance gate fails cold, RSS or hit-ratio regression independently', () => {
	const candidate = doc({ workloads: [{ id: '10k', samples: 10, cold_p95_ms: 130, peak_rss_bytes: 1200, cache_hit_p95_ms: 100, semantic_equivalence: true }] });
	const result = evaluatePerformanceGate({ baseline: doc(), candidate, policy: { maxColdRegressionPct: 15, maxPeakRssRegressionPct: 15, maxCacheHitFractionOfCold: 0.5 } });
	assert.equal(result.status, 'fail');
	assert.deepEqual(result.checks.filter((x) => x.status === 'fail').map((x) => x.code).sort(), ['CACHE_HIT_FRACTION_OF_COLD', 'COLD_REGRESSION_PCT', 'PEAK_RSS_REGRESSION_PCT']);
});
