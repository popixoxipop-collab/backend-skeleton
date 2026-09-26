import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildFileIndex } from './file-index.mjs';
import { runTaskGraph } from './scheduler.mjs';
import { runLegacyScanCached } from './legacy-cache.mjs';
import { buildProjectCachePlan, T21_PROJECT_GRAPH_DRAFT } from './project-cache-plan.mjs';

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function resolveWithin(root, rel) {
	const base = path.resolve(root);
	const target = rel === '.' ? base : path.resolve(base, rel);
	const diff = path.relative(base, target);
	if (diff === '..' || diff.startsWith(`..${path.sep}`) || path.isAbsolute(diff)) throw new Error(`project root escapes repository: ${rel}`);
	return target;
}

function sha256File(file) {
	return 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyMarkers(repoRoot, project) {
	for (const marker of project.markers ?? []) {
		if (typeof marker.path !== 'string' || typeof marker.digest !== 'string') throw new Error(`${project.project_id}: invalid marker record`);
		const file = resolveWithin(repoRoot, marker.path);
		let actual;
		try { actual = sha256File(file); }
		catch (error) {
			const stale = new Error(`project marker is missing or unreadable: ${marker.path}: ${error.message}`);
			stale.code = 'PROJECT_GRAPH_STALE';
			throw stale;
		}
		if (actual !== marker.digest) {
			const stale = new Error(`project marker changed after graph discovery: ${marker.path}`);
			stale.code = 'PROJECT_GRAPH_STALE';
			stale.expected_digest = marker.digest;
			stale.actual_digest = actual;
			throw stale;
		}
	}
}

function adapterMap(adapters) {
	const out = new Map();
	for (const adapter of adapters ?? []) {
		if (!adapter || typeof adapter.id !== 'string') throw new TypeError('adapters must contain descriptor objects with id');
		if (out.has(adapter.id)) throw new Error(`duplicate adapter id: ${adapter.id}`);
		out.set(adapter.id, adapter);
	}
	return out;
}

function reservationFor(index, { baseBytes, sourceMultiplier }) {
	const n = baseBytes + index.stats.bytes * sourceMultiplier;
	if (!Number.isSafeInteger(n) || n < 1) throw new Error('project scan reservation exceeds safe integer range');
	return n;
}

function verifyGraphRepoRoot(graph, repoRoot) {
	if (graph.repo_root === '.') return;
	if (typeof graph.repo_root !== 'string' || !path.isAbsolute(graph.repo_root) || path.resolve(graph.repo_root) !== path.resolve(repoRoot)) {
		const error = new Error('graph repo_root does not match execution repoRoot');
		error.code = 'PROJECT_GRAPH_ROOT_MISMATCH';
		throw error;
	}
}

// Shadow orchestration compatible with T02's draft project graph. Project scans remain independent;
// graph dependency edges are used for invalidation, not to invent an execution order that the
// legacy scanner never required.
export async function runProjectGraphCached({
	repoRoot,
	cacheRoot = repoRoot,
	graph,
	adapters,
	implementationDigests,
	terms = [],
	rgAvailable = true,
	includeFallback = false,
	useCache = true,
	policyFingerprint = null,
	maxConcurrency = 4,
	maxEstimatedBytesInFlight = 512 * 1024 * 1024,
	reservationBaseBytes = 8 * 1024 * 1024,
	reservationSourceMultiplier = 4,
} = {}) {
	if (!repoRoot) throw new TypeError('repoRoot is required');
	if (!graph || graph.schema !== T21_PROJECT_GRAPH_DRAFT) throw new TypeError('expected sbf.project-graph/draft-1');
	verifyGraphRepoRoot(graph, repoRoot);
	if (!implementationDigests || typeof implementationDigests !== 'object') throw new TypeError('implementationDigests map is required');
	if (!Number.isInteger(reservationBaseBytes) || reservationBaseBytes < 0) throw new TypeError('reservationBaseBytes must be a non-negative integer');
	if (!Number.isInteger(reservationSourceMultiplier) || reservationSourceMultiplier < 1) throw new TypeError('reservationSourceMultiplier must be a positive integer');

	const byAdapter = adapterMap(adapters);
	const byProject = new Map(graph.projects.map((project) => [project.project_id, project]));
	const plan = buildProjectCachePlan(graph, { includeFallback });
	const taskData = new Map();

	for (const item of plan.projects) {
		const project = byProject.get(item.project_id);
		if (!project) throw new Error(`planned project missing from graph: ${item.project_id}`);
		verifyMarkers(repoRoot, project);
		const adapter = byAdapter.get(item.adapter_id);
		if (!adapter) {
			const error = new Error(`planned adapter unavailable: ${item.adapter_id}`);
			error.code = 'PROJECT_ADAPTER_UNAVAILABLE';
			throw error;
		}
		const implementationDigest = implementationDigests[item.adapter_id];
		if (typeof implementationDigest !== 'string') throw new Error(`missing implementation digest for adapter: ${item.adapter_id}`);
		const projectRoot = resolveWithin(repoRoot, item.project_root);
		const index = buildFileIndex(projectRoot);
		taskData.set(item.project_id, { item, projectRoot, adapter, implementationDigest, index });
	}

	const tasks = [...taskData.values()].map(({ item, index }) => ({
		id: item.project_id,
		dependsOn: [],
		estimatedBytes: reservationFor(index, { baseBytes: reservationBaseBytes, sourceMultiplier: reservationSourceMultiplier }),
	})).sort((a, b) => compareText(a.id, b.id));

	const scheduled = await runTaskGraph(tasks, async (task) => {
		const data = taskData.get(task.id);
		const result = await runLegacyScanCached({
			repoRoot: data.projectRoot,
			cacheRoot,
			adapter: data.adapter,
			terms,
			rgAvailable,
			implementationDigest: data.implementationDigest,
			cacheNamespace: data.item.cache_namespace,
			policyFingerprint,
			useCache,
		});
		return {
			project_id: data.item.project_id,
			project_root: data.item.project_root,
			adapter_id: data.item.adapter_id,
			cache_namespace: data.item.cache_namespace,
			cache_hit: result.cache_hit,
			cache_key: result.cache_key,
			source_digest: result.source_digest,
			report: result.report,
			artifact: result.artifact,
		};
	}, { maxConcurrency, maxEstimatedBytesInFlight });

	return {
		schema: 'sbf.project-scan-cache-shadow/draft-1',
		graph_schema: graph.schema,
		plan_schema: plan.schema,
		results: scheduled.results,
		metrics: scheduled.metrics,
	};
}
