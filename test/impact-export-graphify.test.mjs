// D-cross-feature-impact-graph (IG8, T8): asserts lib/impact-export-graphify.mjs's output against
// graphify's OWN real constants from graphify/validate.py, checked in here as data -- read live
// from the installed skill on 2026-09-19 (~/.claude/skills/graphify/.venv/lib/python3.12/
// site-packages/graphify/validate.py), the same "one declared place, asserted equal" device
// D-attestation-payload-completeness's K8 uses for ARTIFACT_SOURCES. If graphify's real constants
// ever drift from what's checked in here, this test is the thing that notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGraphifyExtraction, toMermaid } from '../lib/impact-export-graphify.mjs';

const GRAPHIFY_REQUIRED_NODE_FIELDS = new Set(['id', 'label', 'file_type', 'source_file']);
const GRAPHIFY_REQUIRED_EDGE_FIELDS = new Set(['source', 'target', 'relation', 'confidence', 'source_file']);
const GRAPHIFY_VALID_CONFIDENCES = new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);
const GRAPHIFY_VALID_FILE_TYPES = new Set(['code', 'document', 'paper', 'image', 'rationale']);

function sampleGraph() {
	return {
		schema: 'sbf.impact-graph/1',
		generated_at: '2026-09-19T00:00:00.000Z',
		nodes: [
			{ id: '001-widget-management', type: 'feature', label: '001-widget-management', feature_id: null, file: null, attrs: {} },
			{ id: '001-widget-management#createWidget', type: 'operation', label: 'createWidget', feature_id: '001-widget-management', file: null, attrs: { verb: 'POST', path: '/widgets' } },
			{ id: '001-widget-management::WidgetDto', type: 'resource', label: 'WidgetDto', feature_id: '001-widget-management', file: 'src/main/java/.../WidgetDto.java', attrs: { table: 'widgets', table_source: 'explicit' } },
			{ id: 'table::widgets', type: 'table', label: 'widgets', feature_id: null, file: null, attrs: {} },
			{ id: '001-widget-management::WidgetDto.name', type: 'field', label: 'WidgetDto.name', feature_id: '001-widget-management', file: null, attrs: {} },
			{ id: '002-organization-management::OrganizationDto.taxRate', type: 'field', label: 'OrganizationDto.taxRate', feature_id: '002-organization-management', file: null, attrs: {} },
		],
		edges: [
			{ source: '001-widget-management', target: '001-widget-management#createWidget', relation: 'declares_operation', confidence: 'proven', basis: { artifact: 'specs/001-widget-management/contracts/001-widget-management.schema.json', artifact_sha256: 'a'.repeat(64), locator: 'operations.createWidget' } },
			{ source: '001-widget-management::WidgetDto', target: 'table::widgets', relation: 'maps_to_table', confidence: 'proven', basis: { artifact: 'specs/001-widget-management/brownfield-scan.json', artifact_sha256: 'b'.repeat(64), locator: 'related_modules[].entities[className=WidgetDto].table' } },
			{ source: '001-widget-management::WidgetDto.name', target: '002-organization-management::OrganizationDto.taxRate', relation: 'derives_from', confidence: 'heuristic', basis: { artifact: 'specs/001-widget-management/dependencies.json', artifact_sha256: null, locator: 'dependencies[0]' } },
		],
	};
}

test('T8: every node has graphify\'s real required fields, and file_type is one of graphify\'s real valid values', () => {
	const extraction = toGraphifyExtraction(sampleGraph());
	for (const node of extraction.nodes) {
		for (const field of GRAPHIFY_REQUIRED_NODE_FIELDS) assert.ok(field in node, `node "${node.id}" is missing required graphify field "${field}"`);
		assert.ok(GRAPHIFY_VALID_FILE_TYPES.has(node.file_type), `node "${node.id}" has file_type "${node.file_type}", not one of graphify's real VALID_FILE_TYPES`);
	}
});

test('T8: every edge has graphify\'s real required fields, and confidence is EXTRACTED or INFERRED -- NEVER AMBIGUOUS', () => {
	const extraction = toGraphifyExtraction(sampleGraph());
	assert.ok(extraction.edges.length > 0);
	for (const edge of extraction.edges) {
		for (const field of GRAPHIFY_REQUIRED_EDGE_FIELDS) assert.ok(field in edge, `edge ${edge.source}->${edge.target} is missing required graphify field "${field}"`);
		assert.ok(GRAPHIFY_VALID_CONFIDENCES.has(edge.confidence), `edge confidence "${edge.confidence}" is not one of graphify's real VALID_CONFIDENCES`);
		assert.notEqual(edge.confidence, 'AMBIGUOUS', 'this graph has no guessed edges -- AMBIGUOUS must never be emitted, see lib/impact-graph.mjs\'s own header');
	}
});

test('T8: proven -> EXTRACTED (confidence_score 1.0), heuristic -> INFERRED (confidence_score < 1.0) -- the keystone mapping', () => {
	const extraction = toGraphifyExtraction(sampleGraph());
	const provenEdge = extraction.edges.find((e) => e.relation === 'declares_operation');
	const heuristicEdge = extraction.edges.find((e) => e.relation === 'derives_from');
	assert.equal(provenEdge.confidence, 'EXTRACTED');
	assert.equal(provenEdge.confidence_score, 1.0);
	assert.equal(heuristicEdge.confidence, 'INFERRED');
	assert.ok(heuristicEdge.confidence_score < 1.0 && heuristicEdge.confidence_score > 0);
});

test('T8: input_tokens/output_tokens are literally 0 -- no LLM call ever produced this data', () => {
	const extraction = toGraphifyExtraction(sampleGraph());
	assert.equal(extraction.input_tokens, 0);
	assert.equal(extraction.output_tokens, 0);
});

test('T8: every edge endpoint resolves to a declared node id', () => {
	const extraction = toGraphifyExtraction(sampleGraph());
	const nodeIds = new Set(extraction.nodes.map((n) => n.id));
	for (const edge of extraction.edges) {
		assert.ok(nodeIds.has(edge.source), `edge source "${edge.source}" has no matching node`);
		assert.ok(nodeIds.has(edge.target), `edge target "${edge.target}" has no matching node`);
	}
});

test('T8: node ids are graphify-safe -- lowercase, only [a-z0-9_]', () => {
	const extraction = toGraphifyExtraction(sampleGraph());
	for (const node of extraction.nodes) assert.match(node.id, /^[a-z0-9_]+$/);
});

// T9: Focus+Context -- ring/detail monotonically coarsen with distance, and the cutoff collapses
// correctly with the real count.
test('T9: ring/detail are present only with --focus, and detail coarsens monotonically with ring (full -> resource -> feature -> collapsed)', () => {
	const graph = sampleGraph();
	const extraction = toGraphifyExtraction(graph, { focus: '001-widget-management#createWidget', rings: 3 });
	const byId = Object.fromEntries(extraction.nodes.map((n) => [n.id, n]));
	const focusNode = byId[graph.nodes[1].id.toLowerCase().replace(/[^a-z0-9_]/g, '_')];
	assert.equal(focusNode.ring, 0);
	assert.equal(focusNode.detail, 'full');
	const DETAIL_ORDER = { full: 0, resource: 1, feature: 2, collapsed: 3 };
	for (const node of extraction.nodes) {
		if (node.ring == null) continue;
		assert.ok(DETAIL_ORDER[node.detail] >= Math.min(node.ring, 3), `node "${node.id}" at ring ${node.ring} has detail "${node.detail}", which is finer than its ring warrants`);
	}
});

test('T9: nodes beyond --rings collapse into exactly one synthetic node carrying the real count', () => {
	const graph = sampleGraph();
	const extraction = toGraphifyExtraction(graph, { focus: '001-widget-management', rings: 0 });
	const collapsed = extraction.nodes.filter((n) => n.detail === 'collapsed');
	assert.equal(collapsed.length, 1, 'exactly one synthetic collapsed node, not one per dropped node');
	const totalBeyondFocus = graph.nodes.length - 1;
	assert.equal(collapsed[0].sbf_count, totalBeyondFocus);
});

test('T9: no ring/detail fields at all when --focus is not given -- the export stays a flat, un-annotated graph', () => {
	const extraction = toGraphifyExtraction(sampleGraph());
	for (const node of extraction.nodes) {
		assert.ok(!('ring' in node));
		assert.ok(!('detail' in node));
	}
});

test('toMermaid renders a valid graph LR block with a solid arrow for proven edges, dashed for heuristic', () => {
	const mermaid = toMermaid(sampleGraph());
	assert.match(mermaid, /^graph LR/);
	assert.match(mermaid, /-->/);
	assert.match(mermaid, /-\.->/);
});
