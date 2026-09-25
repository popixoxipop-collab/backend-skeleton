function finitePositiveOrNull(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(name, value) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite non-negative number`);
	return value;
}

function positiveInteger(name, value) {
	if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
	return value;
}

function environmentKey(value) {
	if (!value || typeof value !== 'object') return null;
	const required = ['profile_id', 'platform', 'arch', 'node_major'];
	if (required.some((key) => value[key] === undefined || value[key] === null || value[key] === '')) return null;
	return JSON.stringify(required.map((key) => [key, value[key]]));
}

function workloadMap(document, label) {
	if (!document || typeof document !== 'object' || !Array.isArray(document.workloads)) throw new TypeError(`${label}.workloads must be an array`);
	const out = new Map();
	for (const item of document.workloads) {
		if (!item || typeof item.id !== 'string' || item.id === '') throw new TypeError(`${label} workload requires id`);
		if (out.has(item.id)) throw new Error(`${label} contains duplicate workload id: ${item.id}`);
		out.set(item.id, item);
	}
	return out;
}

function pctDelta(candidate, baseline) {
	return ((candidate - baseline) / baseline) * 100;
}

function check(status, code, workload, actual, limit, detail) {
	return { status, code, workload, actual, limit, detail };
}

// Evaluates already-collected measurements; it neither measures nor self-approves a release.
// Missing/mismatched evidence is BLOCKED, semantic mismatch is FAIL, and threshold regression is
// FAIL. This prevents a faster but semantically different cached result from passing a perf gate.
export function evaluatePerformanceGate({
	baseline,
	candidate,
	policy = {},
} = {}) {
	const minSamples = positiveInteger('policy.minSamples', policy.minSamples ?? 5);
	const maxColdRegressionPct = nonNegative('policy.maxColdRegressionPct', policy.maxColdRegressionPct ?? 15);
	const maxPeakRssRegressionPct = nonNegative('policy.maxPeakRssRegressionPct', policy.maxPeakRssRegressionPct ?? 15);
	const maxCacheHitFractionOfCold = nonNegative('policy.maxCacheHitFractionOfCold', policy.maxCacheHitFractionOfCold ?? 0.5);

	const baselineEnv = environmentKey(baseline?.environment);
	const candidateEnv = environmentKey(candidate?.environment);
	const checks = [];
	if (!baselineEnv || !candidateEnv) {
		return { schema: 'sbf.scan-performance-gate/1', status: 'blocked', checks: [check('blocked', 'MISSING_ENVIRONMENT_IDENTITY', null, null, null, 'baseline and candidate require profile_id/platform/arch/node_major')] };
	}
	if (baselineEnv !== candidateEnv) {
		return { schema: 'sbf.scan-performance-gate/1', status: 'blocked', checks: [check('blocked', 'ENVIRONMENT_MISMATCH', null, candidate?.environment ?? null, baseline?.environment ?? null, 'measurements are not directly comparable')] };
	}

	const base = workloadMap(baseline, 'baseline');
	const cand = workloadMap(candidate, 'candidate');
	const ids = [...new Set([...base.keys(), ...cand.keys()])].sort();
	for (const id of ids) {
		const b = base.get(id);
		const c = cand.get(id);
		if (!b || !c) {
			checks.push(check('blocked', 'WORKLOAD_SET_MISMATCH', id, Boolean(c), Boolean(b), 'the same workload must exist in baseline and candidate'));
			continue;
		}
		if (!Number.isInteger(b.samples) || !Number.isInteger(c.samples) || b.samples < minSamples || c.samples < minSamples) {
			checks.push(check('blocked', 'INSUFFICIENT_SAMPLES', id, { baseline: b.samples, candidate: c.samples }, minSamples, 'both sides must meet the minimum sample count'));
			continue;
		}
		if (c.semantic_equivalence !== true) {
			checks.push(check(c.semantic_equivalence === false ? 'fail' : 'blocked', c.semantic_equivalence === false ? 'SEMANTIC_MISMATCH' : 'SEMANTIC_EQUIVALENCE_UNPROVEN', id, c.semantic_equivalence ?? null, true, 'performance never overrides semantic correctness'));
			continue;
		}

		const bCold = finitePositiveOrNull(b.cold_p95_ms);
		const cCold = finitePositiveOrNull(c.cold_p95_ms);
		const bRss = finitePositiveOrNull(b.peak_rss_bytes);
		const cRss = finitePositiveOrNull(c.peak_rss_bytes);
		const hit = finitePositiveOrNull(c.cache_hit_p95_ms);
		if ([bCold, cCold, bRss, cRss, hit].some((value) => value === null)) {
			checks.push(check('blocked', 'MISSING_OR_INVALID_METRIC', id, {
				baseline_cold_p95_ms: b.cold_p95_ms ?? null,
				candidate_cold_p95_ms: c.cold_p95_ms ?? null,
				baseline_peak_rss_bytes: b.peak_rss_bytes ?? null,
				candidate_peak_rss_bytes: c.peak_rss_bytes ?? null,
				candidate_cache_hit_p95_ms: c.cache_hit_p95_ms ?? null,
			}, 'finite positive values', 'required performance evidence is missing or invalid'));
			continue;
		}

		const coldRegression = pctDelta(cCold, bCold);
		checks.push(check(coldRegression <= maxColdRegressionPct ? 'pass' : 'fail', 'COLD_REGRESSION_PCT', id, coldRegression, maxColdRegressionPct, 'candidate cold p95 versus baseline cold p95'));

		const rssRegression = pctDelta(cRss, bRss);
		checks.push(check(rssRegression <= maxPeakRssRegressionPct ? 'pass' : 'fail', 'PEAK_RSS_REGRESSION_PCT', id, rssRegression, maxPeakRssRegressionPct, 'candidate peak RSS versus baseline peak RSS'));

		const hitFraction = hit / cCold;
		checks.push(check(hitFraction <= maxCacheHitFractionOfCold ? 'pass' : 'fail', 'CACHE_HIT_FRACTION_OF_COLD', id, hitFraction, maxCacheHitFractionOfCold, 'cache-hit p95 divided by candidate cold p95'));
	}

	const status = checks.some((item) => item.status === 'blocked')
		? 'blocked'
		: checks.some((item) => item.status === 'fail')
			? 'fail'
			: 'pass';
	return {
		schema: 'sbf.scan-performance-gate/1',
		status,
		environment: baseline.environment,
		policy: { minSamples, maxColdRegressionPct, maxPeakRssRegressionPct, maxCacheHitFractionOfCold },
		checks,
	};
}
