import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JVM_FIXTURES, jvmFixture } from './fixtures.mjs';
import {
	buildJvmAnnotationGraph,
	buildJvmProjectIndex,
	resolveJvmAnnotationName,
} from '../../scanners/language/jvm/annotation-graph.mjs';

function corpus(...ids) {
	return ids.map((id) => {
		const fixture = jvmFixture(id);
		return { path: fixture.path, source: fixture.source };
	});
}

test('project index keeps package-scoped top-level symbols and reports no duplicate FQNs for the corpus', () => {
	const index = buildJvmProjectIndex(
		JVM_FIXTURES.map((fixture) => ({ path: fixture.path, source: fixture.source })),
	);
	assert.deepEqual(index.diagnostics, []);
	assert.ok(index.typesByFqn.has('com.example.meta.ReadOnlyEndpoint'));
	assert.ok(index.typesByFqn.has('com.example.domain.BaseEntity'));
	assert.ok(index.typesByFqn.has('com.example.domain.Widget'));
});

test('annotation resolution uses explicit imports but does not invent external wildcard targets', () => {
	const index = buildJvmProjectIndex(corpus('meta-annotation'));
	const facts = index.fileFacts[0];
	assert.deepEqual(resolveJvmAnnotationName(index, facts, 'RequestMapping'), {
		status: 'resolved',
		fqn: 'org.springframework.web.bind.annotation.RequestMapping',
		basis: 'explicit-import',
		candidates: ['org.springframework.web.bind.annotation.RequestMapping'],
	});
	assert.equal(resolveJvmAnnotationName(index, facts, 'DefinitelyUnknown').status, 'unknown');
});

test('meta-annotation graph resolves imports but does not interpret Spring semantics', () => {
	const graph = buildJvmAnnotationGraph(corpus('meta-annotation'));
	const node = graph.nodes.get('com.example.meta.ReadOnlyEndpoint');
	assert.ok(node);
	const mapping = node.metaAnnotations.find((item) => item.writtenName === 'RequestMapping');
	assert.equal(mapping.resolution.status, 'resolved');
	assert.equal(
		mapping.resolution.fqn,
		'org.springframework.web.bind.annotation.RequestMapping',
	);
	const expanded = graph.expand('com.example.meta.ReadOnlyEndpoint');
	assert.equal(expanded.status, 'resolved');
	assert.ok(expanded.edges.some(
		(edge) => edge.to === 'org.springframework.web.bind.annotation.RequestMapping',
	));
	assert.equal(expanded.edges.some((edge) => Object.hasOwn(edge, 'httpMethod')), false);
});

test('local composed annotations resolve by same-package project type', () => {
	const graph = buildJvmAnnotationGraph(corpus('meta-annotation', 'meta-annotation-cycle'));
	const a = graph.nodes.get('com.example.meta.A');
	assert.equal(a.metaAnnotations[0].resolution.fqn, 'com.example.meta.B');
	assert.equal(a.metaAnnotations[0].resolution.basis, 'same-package-project-type');
});

test('meta-annotation graph reports cycles and terminates', () => {
	const graph = buildJvmAnnotationGraph(corpus('meta-annotation-cycle'));
	const expanded = graph.expand('com.example.meta.A');
	assert.equal(expanded.status, 'cycle');
	assert.deepEqual(
		expanded.cycles,
		[['com.example.meta.A', 'com.example.meta.B', 'com.example.meta.A']],
	);
	assert.equal(expanded.truncated, false);
});

test('bounded expansion marks a local chain partial instead of dropping deeper edges', () => {
	const graph = buildJvmAnnotationGraph(corpus('meta-annotation-cycle'), { maxDepth: 1 });
	const expanded = graph.expand('com.example.meta.A');
	assert.equal(expanded.status, 'partial');
	assert.equal(expanded.truncated, true);
});

test('duplicate FQNs are conflicts, never last-write-wins', () => {
	const source = 'package p; @interface A {}';
	const index = buildJvmProjectIndex([
		{ path: 'one/A.java', source },
		{ path: 'two/A.java', source },
	]);
	assert.equal(Array.isArray(index.typesByFqn.get('p.A')), true);
	assert.equal(index.diagnostics[0].code, 'JVM_DUPLICATE_TOP_LEVEL_TYPE');
});
