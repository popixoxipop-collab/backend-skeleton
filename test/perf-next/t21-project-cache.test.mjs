import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { createArtifactStore } from '../../lib/artifact-store-next/store.mjs';
import { createCacheIndex } from '../../lib/artifact-store-next/cache-index.mjs';
import { digestJson } from '../../lib/scan-scheduler-next/cache-key.mjs';
import { buildProjectCachePlan, propagateProjectInvalidation } from '../../lib/scan-scheduler-next/project-cache-plan.mjs';
import { runProjectGraphCached } from '../../lib/scan-scheduler-next/project-cache-runner.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPRING_ROOT = 'test/fixtures/java-spring';
const FASTAPI_ROOT = 'test/fixtures/python-fastapi/backend';

function markerAt(repoRoot, rel) {
	const bytes = fs.readFileSync(path.join(repoRoot, rel));
	return { path: rel, kind: 'test-marker', digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}

function graphFixture(repoRoot = ROOT, { portable = false } = {}) {
	return {
		schema: 'sbf.project-graph/draft-1',
		repo_root: portable ? '.' : repoRoot,
		projects: [
			{
				project_id: 'project:spring',
				root: SPRING_ROOT,
				kind: 'application',
				markers: [markerAt(repoRoot, `${SPRING_ROOT}/build.gradle`)],
				facets: { http: { selected_adapter: 'java-spring' } },
				fallback_adapter: null,
			},
			{
				project_id: 'project:fastapi',
				root: FASTAPI_ROOT,
				kind: 'application',
				markers: [markerAt(repoRoot, `${FASTAPI_ROOT}/pyproject.toml`)],
				facets: { http: { selected_adapter: 'python-fastapi' } },
				fallback_adapter: null,
			},
			{
				project_id: 'project:aggregate',
				root: '.',
				kind: 'aggregate',
				markers: [],
				facets: { http: { selected_adapter: null } },
				fallback_adapter: 'generic-grep',
			},
		],
		project_edges: [
			{ kind: 'local-package-dependency', from_project_id: 'project:fastapi', to_project_id: 'project:spring', evidence: [] },
			{ kind: 'contains', from_project_id: 'project:aggregate', to_project_id: 'project:spring', evidence: [] },
			{ kind: 'contains', from_project_id: 'project:aggregate', to_project_id: 'project:fastapi', evidence: [] },
		],
		unresolved: [],
		files_read: [],
	};
}

function adapter(id) {
	const value = ADAPTERS.find((candidate) => candidate.id === id);
	assert.ok(value);
	return value;
}

function implementationDigests() {
	return {
		'java-spring': digestJson({ adapter: 'java-spring', revision: 1 }),
		'python-fastapi': digestJson({ adapter: 'python-fastapi', revision: 1 }),
	};
}

function resultValues(report) {
	return Object.fromEntries(report.results.map((entry) => [entry.id, entry.value]));
}

function copyFixtureTree(targetRoot) {
	for (const rel of [SPRING_ROOT, FASTAPI_ROOT]) {
		const target = path.join(targetRoot, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.cpSync(path.join(ROOT, rel), target, { recursive: true });
	}
}

function portablePair() {
	const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-portable-a-'));
	const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-portable-b-'));
	copyFixtureTree(rootA);
	copyFixtureTree(rootB);
	return { rootA, rootB };
}

function singleProjectGraph(graph, projectId) {
	const projects = graph.projects.filter((project) => project.project_id === projectId);
	const ids = new Set(projects.map((project) => project.project_id));
	return {
		...graph,
		projects,
		project_edges: graph.project_edges.filter((edge) => ids.has(edge.from_project_id) && ids.has(edge.to_project_id)),
	};
}

test('T21 project cache plan follows T02 project_root -> adapter_id order and excludes aggregate fallback', () => {
	const plan = buildProjectCachePlan(graphFixture());
	assert.equal(plan.schema, 'sbf.project-cache-plan/draft-1');
	assert.deepEqual(plan.projects.map((x) => [x.project_id, x.adapter_id]), [
		['project:spring', 'java-spring'],
		['project:fastapi', 'python-fastapi'],
	]);
	assert.deepEqual(plan.projects.find((x) => x.project_id === 'project:fastapi').dependency_project_ids, ['project:spring']);
	assert.ok(plan.projects.every((x) => /^[0-9a-f]{64}$/.test(x.cache_namespace)));
});

test('T21 serialized plan order is invariant to project and edge input order; ordered assertion stays exact', () => {
	const canonical = buildProjectCachePlan(graphFixture());
	const perturbedGraph = graphFixture();
	perturbedGraph.projects.reverse();
	perturbedGraph.project_edges.reverse();
	const perturbed = buildProjectCachePlan(perturbedGraph);
	assert.deepEqual(perturbed.projects, canonical.projects);
	assert.deepEqual(perturbed.projects.map((x) => [x.project_root, x.adapter_id]), [
		[SPRING_ROOT, 'java-spring'],
		[FASTAPI_ROOT, 'python-fastapi'],
	]);
});

test('T21 uses locale-independent code-unit root ordering without normalization or case folding', () => {
	const roots = ['나', 'ä', 'z', '가', 'a'];
	const graph = {
		schema: 'sbf.project-graph/draft-1',
		repo_root: '.',
		projects: roots.map((root) => ({
			project_id: `project:${root}`,
			root,
			kind: 'application',
			markers: [],
			facets: { http: { selected_adapter: 'java-spring' } },
			fallback_adapter: null,
		})),
		project_edges: [],
	};
	const plan = buildProjectCachePlan(graph);
	assert.deepEqual(plan.projects.map((x) => x.project_root), ['a', 'z', 'ä', '가', '나']);
});

test('T21 project invalidation propagates dependency -> transitive consumers but ignores containment', () => {
	const graph = graphFixture();
	graph.projects.push({
		project_id: 'project:api',
		root: 'test/fixtures/javascript-express/backend',
		kind: 'application',
		markers: [],
		facets: { http: { selected_adapter: 'javascript-express' } },
		fallback_adapter: null,
	});
	graph.project_edges.push({ kind: 'local-package-dependency', from_project_id: 'project:api', to_project_id: 'project:fastapi', evidence: [] });
	assert.deepEqual(propagateProjectInvalidation(graph, ['project:spring']), ['project:api', 'project:fastapi', 'project:spring']);
	assert.deepEqual(propagateProjectInvalidation(graph, ['project:aggregate']), ['project:aggregate']);
});

test('T21 keeps serialized plan order separate from DAG result order and preserves cache OFF/miss/hit semantics', async () => {
	const graph = graphFixture();
	const serializedPlan = buildProjectCachePlan(graph);
	assert.deepEqual(serializedPlan.projects.map((x) => x.project_id), ['project:spring', 'project:fastapi']);

	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-project-cache-'));
	const adapters = [adapter('java-spring'), adapter('python-fastapi')];
	const digests = implementationDigests();
	const options = {
		repoRoot: ROOT,
		cacheRoot,
		graph,
		adapters,
		implementationDigests: digests,
		maxConcurrency: 2,
		maxEstimatedBytesInFlight: 64 * 1024 * 1024,
	};
	const off = await runProjectGraphCached({ ...options, useCache: false });
	const miss = await runProjectGraphCached({ ...options, useCache: true });
	const hit = await runProjectGraphCached({ ...options, useCache: true });

	// Scheduler output remains task-id ordered; it is not the serialized project plan.
	assert.deepEqual(off.results.map((x) => x.id), ['project:fastapi', 'project:spring']);
	assert.deepEqual(miss.results.map((x) => x.id), ['project:fastapi', 'project:spring']);
	assert.deepEqual(hit.results.map((x) => x.id), ['project:fastapi', 'project:spring']);

	assert.equal(off.metrics.passed, 2);
	assert.equal(miss.metrics.passed, 2);
	assert.equal(hit.metrics.passed, 2);
	const offValues = resultValues(off);
	const missValues = resultValues(miss);
	const hitValues = resultValues(hit);
	for (const id of ['project:spring', 'project:fastapi']) {
		assert.equal(offValues[id].cache_hit, false);
		assert.equal(offValues[id].artifact, null);
		assert.equal(missValues[id].cache_hit, false);
		assert.equal(hitValues[id].cache_hit, true);
		assert.deepEqual(missValues[id].report, offValues[id].report);
		assert.deepEqual(hitValues[id].report, offValues[id].report);
		assert.equal(JSON.stringify(missValues[id].report), JSON.stringify(offValues[id].report));
		assert.equal(JSON.stringify(hitValues[id].report), JSON.stringify(offValues[id].report));
		assert.deepEqual(hitValues[id].artifact, missValues[id].artifact);
	}
});

test('T21 consumes a JSON-portable T02 graph in a different checkout and source drift causes a miss only for the changed project', async () => {
	const { rootA, rootB } = portablePair();
	const graph = JSON.parse(JSON.stringify(graphFixture(rootA, { portable: true })));
	assert.equal(graph.repo_root, '.');

	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-portable-cache-'));
	const options = {
		repoRoot: rootB,
		cacheRoot,
		graph,
		adapters: [adapter('java-spring'), adapter('python-fastapi')],
		implementationDigests: implementationDigests(),
		maxConcurrency: 2,
		maxEstimatedBytesInFlight: 64 * 1024 * 1024,
	};
	const first = await runProjectGraphCached(options);
	const second = await runProjectGraphCached(options);
	const firstValues = resultValues(first);
	const secondValues = resultValues(second);
	for (const id of ['project:spring', 'project:fastapi']) {
		assert.equal(firstValues[id].cache_hit, false);
		assert.equal(secondValues[id].cache_hit, true);
		assert.deepEqual(secondValues[id].report, firstValues[id].report);
	}

	fs.appendFileSync(path.join(rootB, FASTAPI_ROOT, 'app', 'models.py'), '\n# t21 source drift\n');
	const third = await runProjectGraphCached(options);
	const thirdValues = resultValues(third);
	assert.equal(thirdValues['project:spring'].cache_hit, true);
	assert.equal(thirdValues['project:fastapi'].cache_hit, false);
	assert.notEqual(thirdValues['project:fastapi'].source_digest, secondValues['project:fastapi'].source_digest);
	assert.deepEqual(thirdValues['project:fastapi'].report, secondValues['project:fastapi'].report);
});

test('T21 marker drift remains fail-closed for a portable T02 graph', async () => {
	const { rootA, rootB } = portablePair();
	const graph = JSON.parse(JSON.stringify(graphFixture(rootA, { portable: true })));
	fs.appendFileSync(path.join(rootB, SPRING_ROOT, 'build.gradle'), '\n// marker drift\n');
	await assert.rejects(
		runProjectGraphCached({
			repoRoot: rootB,
			cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-project-stale-')),
			graph,
			adapters: [adapter('java-spring'), adapter('python-fastapi')],
			implementationDigests: implementationDigests(),
		}),
		(error) => error.code === 'PROJECT_GRAPH_STALE',
	);
});

test('T21 policy fingerprint changes invalidate project cache without changing scan semantics', async () => {
	const { rootA, rootB } = portablePair();
	const graph = singleProjectGraph(JSON.parse(JSON.stringify(graphFixture(rootA, { portable: true }))), 'project:fastapi');
	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-policy-cache-'));
	const base = {
		repoRoot: rootB,
		cacheRoot,
		graph,
		adapters: [adapter('python-fastapi')],
		implementationDigests: implementationDigests(),
		maxConcurrency: 1,
		maxEstimatedBytesInFlight: 64 * 1024 * 1024,
	};
	const p1 = digestJson({ policy: 'one' });
	const p2 = digestJson({ policy: 'two' });
	const first = await runProjectGraphCached({ ...base, policyFingerprint: p1 });
	const hit = await runProjectGraphCached({ ...base, policyFingerprint: p1 });
	const changed = await runProjectGraphCached({ ...base, policyFingerprint: p2 });
	const a = resultValues(first)['project:fastapi'];
	const b = resultValues(hit)['project:fastapi'];
	const c = resultValues(changed)['project:fastapi'];
	assert.equal(a.cache_hit, false);
	assert.equal(b.cache_hit, true);
	assert.equal(c.cache_hit, false);
	assert.equal(a.cache_key, b.cache_key);
	assert.notEqual(c.cache_key, b.cache_key);
	assert.deepEqual(c.report, b.report);
});

test('T21 corrupted project cache fails closed instead of silently recomputing', async () => {
	const { rootA, rootB } = portablePair();
	const graph = singleProjectGraph(JSON.parse(JSON.stringify(graphFixture(rootA, { portable: true }))), 'project:fastapi');
	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-corrupt-project-cache-'));
	const options = {
		repoRoot: rootB,
		cacheRoot,
		graph,
		adapters: [adapter('python-fastapi')],
		implementationDigests: implementationDigests(),
		maxConcurrency: 1,
		maxEstimatedBytesInFlight: 64 * 1024 * 1024,
	};
	const primed = await runProjectGraphCached(options);
	assert.equal(primed.metrics.passed, 1);
	const index = createCacheIndex(cacheRoot);
	const entries = index.list();
	assert.equal(entries.length, 1);
	const store = createArtifactStore(path.join(cacheRoot, '.sbf', 'cache-next', 'artifacts'));
	fs.writeFileSync(store.pathForDigest(entries[0].artifact.digest), 'tampered');

	const after = await runProjectGraphCached(options);
	assert.equal(after.metrics.passed, 0);
	assert.equal(after.metrics.failed, 1);
	assert.equal(after.results[0].status, 'failed');
	assert.match(after.results[0].error, /artifact failed integrity check/);
	assert.equal(index.list().length, 1);
});

test('T21 dependency graph change forces a new cache namespace for the affected project', () => {
	const graph = graphFixture();
	const before = buildProjectCachePlan(graph);
	const fastBefore = before.projects.find((x) => x.project_id === 'project:fastapi').cache_namespace;
	graph.project_edges = graph.project_edges.filter((edge) => edge.kind !== 'local-package-dependency');
	const after = buildProjectCachePlan(graph);
	const fastAfter = after.projects.find((x) => x.project_id === 'project:fastapi').cache_namespace;
	assert.notEqual(fastBefore, fastAfter);
});
