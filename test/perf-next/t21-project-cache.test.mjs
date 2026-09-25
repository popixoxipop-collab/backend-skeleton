import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../../scanners/registry.mjs';
import { digestJson } from '../../lib/scan-scheduler-next/cache-key.mjs';
import { buildProjectCachePlan, propagateProjectInvalidation } from '../../lib/scan-scheduler-next/project-cache-plan.mjs';
import { runProjectGraphCached } from '../../lib/scan-scheduler-next/project-cache-runner.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function marker(rel) {
	const bytes = fs.readFileSync(path.join(ROOT, rel));
	return { path: rel, kind: 'test-marker', digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
}

function graphFixture() {
	return {
		schema: 'sbf.project-graph/draft-1',
		repo_root: ROOT,
		projects: [
			{
				project_id: 'project:spring',
				root: 'test/fixtures/java-spring',
				kind: 'application',
				markers: [marker('test/fixtures/java-spring/build.gradle')],
				facets: { http: { selected_adapter: 'java-spring' } },
				fallback_adapter: null,
			},
			{
				project_id: 'project:fastapi',
				root: 'test/fixtures/python-fastapi/backend',
				kind: 'application',
				markers: [marker('test/fixtures/python-fastapi/backend/pyproject.toml')],
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

test('T21 project cache plan consumes T02 draft shape without treating aggregate fallback as a first-class scan', () => {
	const plan = buildProjectCachePlan(graphFixture());
	assert.equal(plan.schema, 'sbf.project-cache-plan/draft-1');
	assert.deepEqual(plan.projects.map((x) => [x.project_id, x.adapter_id]), [
		['project:fastapi', 'python-fastapi'],
		['project:spring', 'java-spring'],
	]);
	assert.deepEqual(plan.projects.find((x) => x.project_id === 'project:fastapi').dependency_project_ids, ['project:spring']);
	assert.ok(plan.projects.every((x) => /^[0-9a-f]{64}$/.test(x.cache_namespace)));
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

test('T21 project graph cache runner gives per-project misses then hits with unchanged legacy reports', async () => {
	const graph = graphFixture();
	const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-project-cache-'));
	const adapters = [adapter('java-spring'), adapter('python-fastapi')];
	const implementationDigests = {
		'java-spring': digestJson({ adapter: 'java-spring', revision: 1 }),
		'python-fastapi': digestJson({ adapter: 'python-fastapi', revision: 1 }),
	};
	const first = await runProjectGraphCached({
		repoRoot: ROOT,
		cacheRoot,
		graph,
		adapters,
		implementationDigests,
		maxConcurrency: 2,
		maxEstimatedBytesInFlight: 64 * 1024 * 1024,
	});
	const second = await runProjectGraphCached({
		repoRoot: ROOT,
		cacheRoot,
		graph,
		adapters,
		implementationDigests,
		maxConcurrency: 2,
		maxEstimatedBytesInFlight: 64 * 1024 * 1024,
	});
	assert.equal(first.metrics.passed, 2);
	assert.equal(second.metrics.passed, 2);
	const firstValues = Object.fromEntries(first.results.map((x) => [x.id, x.value]));
	const secondValues = Object.fromEntries(second.results.map((x) => [x.id, x.value]));
	for (const id of ['project:spring', 'project:fastapi']) {
		assert.equal(firstValues[id].cache_hit, false);
		assert.equal(secondValues[id].cache_hit, true);
		assert.deepEqual(secondValues[id].report, firstValues[id].report);
		assert.equal(secondValues[id].adapter_id, firstValues[id].adapter_id);
	}
});

test('T21 project graph runner fails closed if a T02 marker drifted', async () => {
	const graph = graphFixture();
	graph.projects.find((x) => x.project_id === 'project:spring').markers[0].digest = 'sha256:' + '0'.repeat(64);
	await assert.rejects(
		runProjectGraphCached({
			repoRoot: ROOT,
			cacheRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'bskel-t21-project-stale-')),
			graph,
			adapters: [adapter('java-spring'), adapter('python-fastapi')],
			implementationDigests: {
				'java-spring': digestJson({ adapter: 'java-spring', revision: 1 }),
				'python-fastapi': digestJson({ adapter: 'python-fastapi', revision: 1 }),
			},
		}),
		(error) => error.code === 'PROJECT_GRAPH_STALE',
	);
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
