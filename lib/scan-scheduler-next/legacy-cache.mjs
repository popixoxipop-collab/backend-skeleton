import path from 'node:path';
import { runScan } from '../../scanners/index.mjs';
import { buildScanCacheKey, digestJson } from './cache-key.mjs';
import { buildFileIndex } from './file-index.mjs';
import { runCachedTask } from './cache-runtime.mjs';
import { createArtifactStore } from '../artifact-store-next/store.mjs';
import { createCacheIndex } from '../artifact-store-next/cache-index.mjs';

const SHA256_RE = /^[0-9a-f]{64}$/;

function requireDigest(name, value) {
	if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError(`${name} must be a lowercase sha256 digest`);
	return value;
}

function adapterSnapshot(adapter) {
	if (!adapter || typeof adapter !== 'object' || typeof adapter.id !== 'string') throw new TypeError('adapter descriptor is required');
	return {
		contract: adapter.contract ?? null,
		id: adapter.id,
		title: adapter.title ?? null,
		specificity: adapter.specificity ?? null,
		confidence: adapter.confidence ?? null,
		verification_basis: adapter.verificationBasis ?? null,
		capabilities: adapter.capabilities ?? {},
	};
}

function defaultRuntimeFingerprint() {
	return `node=${process.versions.node};platform=${process.platform};arch=${process.arch}`;
}

function validateLegacyReport(report, adapterId) {
	if (!report || report.schema !== 'sbf.scan-report/2') throw new Error('legacy scan cache only accepts sbf.scan-report/2');
	if (report.adapter !== adapterId) throw new Error(`legacy scan cache expected adapter ${adapterId}, got ${report.adapter ?? '(missing)'}`);
	return report;
}

function preserveJson(value) {
	return Buffer.from(JSON.stringify(value), 'utf8');
}

function parseJson(bytes) {
	return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

// T21 shadow integration for the existing single-project scanner. It does not modify runScan().
// Callers must provide an implementationDigest that covers the adapter/parser implementation
// revision they trust; descriptor equality alone is not enough to make code changes cache-safe.
export async function runLegacyScanCached({
	repoRoot,
	cacheRoot = repoRoot,
	adapter,
	terms = [],
	rgAvailable = true,
	implementationDigest,
	runtimeFingerprint = defaultRuntimeFingerprint(),
	useCache = true,
	indexOptions = {},
} = {}) {
	if (!repoRoot) throw new TypeError('repoRoot is required');
	if (!Array.isArray(terms) || terms.some((x) => typeof x !== 'string')) throw new TypeError('terms must be a string array');
	requireDigest('implementationDigest', implementationDigest);
	const descriptor = adapterSnapshot(adapter);
	const fileIndex = buildFileIndex(repoRoot, indexOptions);
	const cacheKey = buildScanCacheKey({
		sourceDigest: fileIndex.source_digest,
		resolverDigest: digestJson({
			mode: 'legacy-single-project',
			adapter_id: descriptor.id,
			rg_available: Boolean(rgAvailable),
			include_db: false,
			runtime_routes: false,
		}),
		configDigest: digestJson({ terms }),
		parserDigest: implementationDigest,
		adapterDigest: digestJson({ implementation_digest: implementationDigest, descriptor }),
		schemaDigest: digestJson({ scan_schema: 'sbf.scan-report/2' }),
		policyDigest: digestJson({
			cache_contract: 't21-legacy-scan-shadow/1',
			db: 'disabled',
			runtime_routes: 'disabled',
			cache_corruption: 'fail-closed',
		}),
		runtimeFingerprint,
	});

	const compute = async () => validateLegacyReport(runScan({
		repoRoot,
		terms,
		includeDb: false,
		dbSchema: null,
		adapters: [adapter],
		rgAvailable,
		runtimeRoutes: false,
	}), descriptor.id);

	if (!useCache) {
		const report = await compute();
		return {
			schema: 'sbf.legacy-scan-cache-result/1',
			cache_used: false,
			cache_hit: false,
			cache_key: cacheKey.digest,
			source_digest: fileIndex.source_digest,
			report,
			artifact: null,
		};
	}

	const root = path.resolve(cacheRoot);
	const artifactStore = createArtifactStore(path.join(root, '.sbf', 'cache-next', 'artifacts'));
	const cacheIndex = createCacheIndex(root);
	const result = await runCachedTask({
		cacheKey: cacheKey.digest,
		cacheIndex,
		artifactStore,
		compute,
		// Whole-index dependencies are conservative. Once T02/T11 read-set plumbing is frozen,
		// this can narrow to the exact adapter/project read set without changing cache semantics.
		dependencies: fileIndex.entries.map((entry) => entry.path),
		metadata: {
			adapter_id: descriptor.id,
			source_digest: fileIndex.source_digest,
			cache_contract: 't21-legacy-scan-shadow/1',
		},
		serialize: preserveJson,
		deserialize: parseJson,
		validate: (value) => validateLegacyReport(value, descriptor.id),
	});
	return {
		schema: 'sbf.legacy-scan-cache-result/1',
		cache_used: true,
		cache_hit: result.cache_hit,
		cache_key: cacheKey.digest,
		source_digest: fileIndex.source_digest,
		report: result.value,
		artifact: result.artifact,
	};
}
