import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runScan } from '../../scanners/index.mjs';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { digestJson } from '../../lib/scan-scheduler-next/cache-key.mjs';
import { runLegacyScanCached } from '../../lib/scan-scheduler-next/legacy-cache.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = {
	'java-spring': 'test/fixtures/java-spring',
	'ruby-rails': 'test/fixtures/ruby-rails/backend',
	'python-fastapi': 'test/fixtures/python-fastapi/backend',
	'typescript-express': 'test/fixtures/typescript-express/backend',
	'javascript-express': 'test/fixtures/javascript-express/backend',
};

function arg(name, fallback = null) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

function positiveInt(name, fallback) {
	const value = Number(arg(name, fallback));
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} requires a positive integer`);
	return value;
}

function percentile(values, p) {
	if (!values.length) throw new Error('cannot compute percentile of empty sample set');
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[index];
}

function adapterById(id) {
	const adapter = ADAPTERS.find((candidate) => candidate.id === id);
	if (!adapter) throw new Error(`unknown adapter: ${id}`);
	return adapter;
}

function sameBytes(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

const samples = positiveInt('--samples', 7);
const requested = arg('--adapter');
const ids = requested ? [requested] : Object.keys(FIXTURES);
const workloads = [];

for (const id of ids) {
	if (!FIXTURES[id]) throw new Error(`benchmark has no committed fixture for adapter: ${id}`);
	const adapter = adapterById(id);
	const repoRoot = path.join(ROOT, FIXTURES[id]);
	const implementationDigest = digestJson({ benchmark: 't21-legacy-cache/1', adapter_id: id });
	const directTimes = [];
	const coldTimes = [];
	const hitTimes = [];
	let directReference = null;
	let coldEquivalent = true;
	let hitEquivalent = true;

	for (let i = 0; i < samples; i++) {
		const start = performance.now();
		const report = runScan({ repoRoot, terms: [], adapters: [adapter], includeDb: false, runtimeRoutes: false });
		directTimes.push(performance.now() - start);
		directReference ??= report;
		if (!sameBytes(report, directReference)) throw new Error(`${id}: direct legacy scan became non-deterministic during benchmark`);
	}

	for (let i = 0; i < samples; i++) {
		const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bskel-t21-bench-${id}-cold-`));
		try {
			const start = performance.now();
			const result = await runLegacyScanCached({ repoRoot, cacheRoot, adapter, terms: [], implementationDigest, useCache: true });
			coldTimes.push(performance.now() - start);
			if (result.cache_hit) throw new Error(`${id}: fresh cache root unexpectedly produced a hit`);
			coldEquivalent = coldEquivalent && sameBytes(result.report, directReference);
		} finally {
			fs.rmSync(cacheRoot, { recursive: true, force: true });
		}
	}

	const hitCacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bskel-t21-bench-${id}-hit-`));
	try {
		const primed = await runLegacyScanCached({ repoRoot, cacheRoot: hitCacheRoot, adapter, terms: [], implementationDigest, useCache: true });
		if (primed.cache_hit) throw new Error(`${id}: cache prime unexpectedly hit`);
		for (let i = 0; i < samples; i++) {
			const start = performance.now();
			const result = await runLegacyScanCached({ repoRoot, cacheRoot: hitCacheRoot, adapter, terms: [], implementationDigest, useCache: true });
			hitTimes.push(performance.now() - start);
			if (!result.cache_hit) throw new Error(`${id}: primed cache unexpectedly missed`);
			hitEquivalent = hitEquivalent && sameBytes(result.report, directReference);
		}
	} finally {
		fs.rmSync(hitCacheRoot, { recursive: true, force: true });
	}

	workloads.push({
		id,
		samples,
		legacy_direct_p50_ms: Number(percentile(directTimes, 0.50).toFixed(3)),
		legacy_direct_p95_ms: Number(percentile(directTimes, 0.95).toFixed(3)),
		cache_cold_p50_ms: Number(percentile(coldTimes, 0.50).toFixed(3)),
		cache_cold_p95_ms: Number(percentile(coldTimes, 0.95).toFixed(3)),
		cache_hit_p50_ms: Number(percentile(hitTimes, 0.50).toFixed(3)),
		cache_hit_p95_ms: Number(percentile(hitTimes, 0.95).toFixed(3)),
		semantic_equivalence: coldEquivalent && hitEquivalent,
		report_bytes: Buffer.byteLength(JSON.stringify(directReference), 'utf8'),
	});
}

console.log(JSON.stringify({
	schema: 'sbf.t21-legacy-cache-benchmark/1',
	environment: {
		profile_id: arg('--profile-id', 'local-unapproved'),
		platform: process.platform,
		arch: process.arch,
		node_major: Number(process.versions.node.split('.')[0]),
		node_version: process.versions.node,
	},
	workloads,
	notes: [
		'timing harness only; profile local-unapproved is not a release certification',
		'peak RSS is deliberately absent because in-process RSS deltas are not a reliable per-workload peak measurement',
		'performance gate must remain BLOCKED until approved external peak-RSS measurements are supplied',
		'cache hit still rebuilds the content index before key lookup; this measures current correctness-first implementation',
	],
}, null, 2));
