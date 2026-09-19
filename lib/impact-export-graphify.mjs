// D-cross-feature-impact-graph (IG8/IG9): the ONE seam to the LLM-driven exploration layer -- writes
// graphify's own extraction file shape (graphify.build.build_from_json's input contract), bypassing
// its Steps 1-3 (install/detect/extract) entirely, so `bskel impact export --format graphify` needs
// no LLM call, no subagent, no network. `impact-atlas` (or any other consumer) runs `build_from_json`
// + `cluster` + `to_obsidian` on this file -- see DECISIONS.md's IG8 for the exact commands.
//
// The confidence mapping is the keystone: `proven` -> EXTRACTED, `heuristic` -> INFERRED. AMBIGUOUS
// is NEVER emitted -- this graph has no guessed edges (see lib/impact-graph.mjs's own header), so
// there is nothing honest to put there. A dedicated test (test/impact-export-graphify.test.mjs)
// asserts this file's output against graphify's own real REQUIRED_NODE_FIELDS/REQUIRED_EDGE_FIELDS/
// VALID_FILE_TYPES/VALID_CONFIDENCES constants, checked in as data -- the same "one declared place,
// asserted equal" device D-attestation-payload-completeness's K8 uses for ARTIFACT_SOURCES.
//
// IG9 (Focus+Context, Lamping/Rao/Pirolli CHI'95): implemented as a DATA PROJECTION, not a renderer
// -- `ring` (geodesic hop distance from --focus over the impact graph's own edges) and `detail`
// (progressively coarser as ring grows) are computed here and written into the export ONLY, never
// into anything a gate reads. Every downstream consumer (Obsidian's graph view, graphify's own
// --html, Mermaid, Neo4j) inherits the same compression for free.
const NODE_TYPE_TO_FILE_TYPE = { feature: 'document', operation: 'code', resource: 'code', table: 'document', field: 'code' };
const RELATION_CONFIDENCE_SCORE = { EXTRACTED: 1.0, INFERRED: 0.7 };

function graphifyConfidence(edgeConfidence) {
	return edgeConfidence === 'proven' ? 'EXTRACTED' : 'INFERRED';
}

function sourceFileFor(node) {
	if (node.file) return node.file;
	if (node.type === 'feature') return `specs/${node.id}/feature.json`;
	if (node.type === 'table') return '.sbf/impact-graph.json';
	return '.sbf/impact-graph.json';
}

function nodeIdSafe(id) {
	// graphify's own convention: lowercase, only [a-z0-9_] -- see its SKILL.md's Node ID format.
	// bskel's own ids ("001-org::Organization", "001-org#getOrg") stay human-legible in `label`;
	// this is only the graphify-facing id.
	return id.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

// BFS hop distance from `focusId` over the graph's edges treated as undirected -- Focus+Context
// has no notion of edge direction, only "how far is this from what I'm looking at".
function hopDistances(graph, focusId) {
	const adj = new Map();
	const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
	for (const e of graph.edges) { link(e.source, e.target); link(e.target, e.source); }
	const dist = new Map([[focusId, 0]]);
	const queue = [focusId];
	while (queue.length > 0) {
		const cur = queue.shift();
		for (const next of adj.get(cur) ?? []) {
			if (dist.has(next)) continue;
			dist.set(next, dist.get(cur) + 1);
			queue.push(next);
		}
	}
	return dist;
}

function detailForRing(ring) {
	if (ring === 0) return 'full';
	if (ring === 1) return 'resource';
	if (ring === 2) return 'feature';
	return 'collapsed';
}

export function toGraphifyExtraction(graph, { focus = null, rings = null } = {}) {
	let nodes = graph.nodes;
	let edges = graph.edges;
	let ringOf = null;

	if (focus) {
		const dist = hopDistances(graph, focus);
		ringOf = dist;
		if (Number.isInteger(rings)) {
			const kept = [];
			let collapsedCount = 0;
			for (const n of graph.nodes) {
				const d = dist.has(n.id) ? dist.get(n.id) : Infinity;
				if (d <= rings) kept.push(n);
				else collapsedCount++;
			}
			const keptIds = new Set(kept.map((n) => n.id));
			const collapsedId = '__collapsed__';
			const redirected = [];
			const seenRedirect = new Set();
			for (const e of graph.edges) {
				const sIn = keptIds.has(e.source);
				const tIn = keptIds.has(e.target);
				if (sIn && tIn) { redirected.push(e); continue; }
				if (!sIn && !tIn) continue; // both collapsed -- drop, nothing new to show
				const kept_ = sIn ? e.source : e.target;
				const key = `${kept_}->${collapsedId}`;
				if (seenRedirect.has(key)) continue;
				seenRedirect.add(key);
				redirected.push({ source: sIn ? kept_ : collapsedId, target: sIn ? collapsedId : kept_, relation: e.relation, confidence: e.confidence, basis: e.basis });
			}
			nodes = collapsedCount > 0
				? [...kept, { id: collapsedId, type: 'collapsed', label: `…${collapsedCount} more`, feature_id: null, file: null, attrs: { count: collapsedCount } }]
				: kept;
			edges = redirected;
		}
	}

	const extractedNodes = nodes.map((n) => {
		const ring = ringOf && n.id !== '__collapsed__' ? (ringOf.has(n.id) ? Math.min(ringOf.get(n.id), (rings ?? Infinity) + 1) : null) : null;
		return {
			id: nodeIdSafe(n.id),
			label: n.label,
			file_type: n.type === 'collapsed' ? 'document' : (NODE_TYPE_TO_FILE_TYPE[n.type] ?? 'document'),
			source_file: n.type === 'collapsed' ? '.sbf/impact-graph.json' : sourceFileFor(n),
			source_location: null,
			sbf_type: n.type,
			sbf_feature: n.feature_id,
			...(focus ? { ring, detail: n.id === '__collapsed__' ? 'collapsed' : detailForRing(ring ?? 0) } : {}),
			...(n.type === 'collapsed' ? { sbf_count: n.attrs.count } : {}),
		};
	});

	const extractedEdges = edges.map((e) => {
		const confidence = graphifyConfidence(e.confidence);
		return {
			source: nodeIdSafe(e.source),
			target: nodeIdSafe(e.target),
			relation: e.relation,
			confidence,
			confidence_score: RELATION_CONFIDENCE_SCORE[confidence],
			source_file: e.basis?.artifact ?? '.sbf/impact-graph.json',
			source_location: e.basis?.locator ?? null,
			sbf_basis_sha256: e.basis?.artifact_sha256 ?? null,
		};
	});

	return { nodes: extractedNodes, edges: extractedEdges, input_tokens: 0, output_tokens: 0 };
}

export function toMermaid(graph) {
	const lines = ['graph LR'];
	const safe = (id) => `"${id.replace(/"/g, '\'')}"`;
	for (const n of graph.nodes) lines.push(`  ${nodeIdSafe(n.id)}[${safe(n.label)}]`);
	for (const e of graph.edges) {
		const arrow = e.confidence === 'proven' ? '-->' : '-.->';
		lines.push(`  ${nodeIdSafe(e.source)} ${arrow}|${e.relation}| ${nodeIdSafe(e.target)}`);
	}
	return lines.join('\n');
}
