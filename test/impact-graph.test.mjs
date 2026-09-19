// D-cross-feature-impact-graph (IG1, T1): buildImpactGraph() over the real two-feature fixture
// (001-widget-management depends on 002-organization-management's OrganizationDto.taxRate) --
// asserts the exact node/edge shape, and that every edge's basis.artifact_sha256 matches a real
// sha256File() of the named artifact.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, buildTwoFeatureFixtureRepo, initBothFeatures, declareArgs } from './_contract-fixture.mjs';
import { buildImpactGraph } from '../lib/impact-graph.mjs';

function sha256File(p) {
	return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('buildImpactGraph: feature nodes exist for both features, with no dependency declared yet', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const graph = buildImpactGraph(root);
	const featureNodes = graph.nodes.filter((n) => n.type === 'feature').map((n) => n.id);
	assert.deepEqual(featureNodes.sort(), ['001-widget-management', '002-organization-management']);
	assert.ok(!graph.edges.some((e) => e.relation === 'derives_from'), 'no derives_from edge before any dependency is declared');
});

test('buildImpactGraph: resource nodes carry table/table_source, and maps_to_table is proven only for an explicit table', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	const graph = buildImpactGraph(root);
	const widgetResource = graph.nodes.find((n) => n.id === '001-widget-management::WidgetDto');
	assert.ok(widgetResource, 'WidgetDto resource node must exist');
	assert.equal(widgetResource.feature_id, '001-widget-management');
	const mapsToTable = graph.edges.find((e) => e.relation === 'maps_to_table' && e.source === '001-widget-management::WidgetDto');
	if (widgetResource.attrs.table) {
		assert.ok(mapsToTable, 'a resource with a table must have a maps_to_table edge');
		assert.equal(mapsToTable.confidence, widgetResource.attrs.table_source === 'explicit' ? 'proven' : 'heuristic');
	}
});

test('buildImpactGraph: after declaring a dependency, a derives_from edge appears with a basis whose artifact_sha256 matches the real file', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	assert.equal(run(declareArgs({}), root).code, 0);
	const graph = buildImpactGraph(root);

	const edge = graph.edges.find((e) => e.relation === 'derives_from');
	assert.ok(edge, 'a derives_from edge must exist after dependency declare');
	assert.equal(edge.source, '001-widget-management::WidgetDto.name');
	assert.equal(edge.target, '002-organization-management::OrganizationDto.taxRate');
	assert.equal(edge.confidence, 'proven');

	const realHash = sha256File(`${root}/${edge.basis.artifact}`);
	assert.equal(edge.basis.artifact_sha256, realHash, 'basis.artifact_sha256 must match a real, independently-computed sha256 of the named artifact');
	assert.match(edge.basis.artifact, /dependencies\.json$/);
});

test('buildImpactGraph: field nodes on both sides of a declared dependency carry the correct feature_id', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	const graph = buildImpactGraph(root);
	const targetField = graph.nodes.find((n) => n.id === '001-widget-management::WidgetDto.name');
	const sourceField = graph.nodes.find((n) => n.id === '002-organization-management::OrganizationDto.taxRate');
	assert.equal(targetField.feature_id, '001-widget-management');
	assert.equal(sourceField.feature_id, '002-organization-management');
});

test('buildImpactGraph: no calls relation is ever emitted -- it does not exist in this codebase\'s vocabulary', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	const graph = buildImpactGraph(root);
	const VALID_RELATIONS = new Set(['declares_operation', 'owns_resource', 'maps_to_table', 'derives_from', 'fk_references', 'name_collides_with']);
	for (const edge of graph.edges) {
		assert.ok(VALID_RELATIONS.has(edge.relation), `unexpected relation "${edge.relation}"`);
		assert.notEqual(edge.relation, 'calls');
	}
});

test('buildImpactGraph: every edge carries a confidence of exactly "proven" or "heuristic" -- no third tier', () => {
	const root = buildTwoFeatureFixtureRepo();
	initBothFeatures(root);
	run(declareArgs({}), root);
	const graph = buildImpactGraph(root);
	for (const edge of graph.edges) assert.ok(['proven', 'heuristic'].includes(edge.confidence));
});
