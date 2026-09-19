// D-cross-feature-impact-graph: builds the deterministic reference-links graph -- exact identities
// only (contract operations, scan-report resourceTypes/tables, declared dependencies.json edges,
// cross-feature-report.json findings), every one already hashed by an existing gate. Zero new
// source-scanning: every fact here is read from a file some OTHER command already wrote and
// validated. No `calls` relation, no inferred/guessed edge -- service-to-service and dynamic-client
// dependency inference is Codex's own named boundary (see DECISIONS.md's EXIT list) and a missing
// edge here is honest; a guessed one would be gate fatigue.
//
// Deliberately NOT called from lib/gate-definitions.mjs's `impact.recompute()` -- this does real
// work (O(features x artifacts) file reads), which is exactly why the gate stays a pure
// sha256File() token over impact-baseline.json/impact-report.json/impact-resolution.json instead.
//
// Scope cut from the original design (disclosed, not silent): a `handle` node type (UUID field
// pointer, backed by `handles plan`'s live output) was planned but is NOT built in this pass --
// `bskel handles plan` never persists a handles-plan.json (verified live: cmdHandlesPlan's own
// comment says "that command never writes, dryRun always"), so producing a handle node here would
// mean calling provider.plan() live inside a graph builder, with its own adapter-capability-gating
// and error surface. Left as a named follow-up (see DECISIONS.md's EXIT list) rather than half-built.
import path from 'node:path';
import { readJsonIfExists, sha256File } from './fsutil.mjs';
import { specPath } from './paths.mjs';
import { listFeatures } from './featurelifecycle.mjs';
import { hydrateScanReportFilePaths } from './scan-report-paths.mjs';
import { loadFieldDependencies } from './field-dependencies.mjs';
import { loadCrossFeatureReport } from './cross-feature-collisions.mjs';

const IMPACT_GRAPH_SCHEMA = 'sbf.impact-graph/1';

function ownDisposedModule(root, featureId) {
	const report = hydrateScanReportFilePaths(readJsonIfExists(specPath(root, featureId, 'brownfield-scan.json')), root);
	if (!report) return null;
	const moduleName = report.disposition?.module ?? report.related_modules?.[0]?.module;
	if (!moduleName) return null;
	return report.related_modules?.find((m) => m.module === moduleName) ?? null;
}

function ownClasses(root, featureId) {
	const mod = ownDisposedModule(root, featureId);
	return mod ? [...(mod.entities ?? []), ...(mod.dtos ?? [])] : [];
}

function loadOwnContract(root, featureId) {
	return readJsonIfExists(specPath(root, featureId, 'contracts', `${featureId}.schema.json`));
}

function resourceNodeId(featureId, resourceType) {
	return `${featureId}::${resourceType}`;
}

function tableNodeId(tableName) {
	return `table::${tableName.toLowerCase()}`;
}

function operationNodeId(featureId, opId) {
	return `${featureId}#${opId}`;
}

function fieldNodeId(featureId, resourceType, fieldName) {
	return `${featureId}::${resourceType}.${fieldName}`;
}

// Parses a `db_foreign_key` finding's flattened `"a.b -> c.d"` identifier back into its four parts
// (the same shape flattenLiveForeignKeys()/findCollisions() in lib/cross-feature-collisions.mjs
// composed it from -- there is no richer, unflattened form persisted anywhere to read instead).
function parseFkIdentifier(identifier) {
	const m = identifier.match(/^(.+)\.([^.]+) -> (.+)\.([^.]+)$/);
	if (!m) return null;
	return { table: m[1], column: m[2], referencesTable: m[3], referencesColumn: m[4] };
}

function confidenceOf(finding) {
	return finding.confidence === 'high' ? 'proven' : 'heuristic';
}

// D-cross-feature-impact-graph (D2): the pure graph builder. Returns { schema, generated_at, nodes,
// edges } matching schemas/impact-graph.schema.json. `nowIso` is injected (never Date.now()/`new
// Date()` computed internally past this one seam) so callers -- and this module's own tests -- can
// pin a deterministic generated_at.
export function buildImpactGraph(root, { nowIso = new Date().toISOString() } = {}) {
	const nodes = new Map();
	const edges = [];
	const addNode = (id, type, label, extra = {}) => {
		if (!nodes.has(id)) nodes.set(id, { id, type, label, feature_id: extra.feature_id ?? null, file: extra.file ?? null, attrs: extra.attrs ?? {} });
		return id;
	};
	const addEdge = (source, target, relation, confidence, basis) => {
		edges.push({ source, target, relation, confidence, basis });
	};
	const relBasis = (root_, relPath, locator) => {
		const abs = specPath(root_, ...relPath);
		return { artifact: path.relative(root_, abs), artifact_sha256: sha256File(abs), locator };
	};

	const features = listFeatures(root);
	const resourceTableOf = new Map(); // "<fid>::<Type>" -> table node id, for maps_to_table lookups below

	for (const record of features) {
		const fid = record.feature_id;
		addNode(fid, 'feature', fid);

		// operations, from the emitted contract
		const contract = loadOwnContract(root, fid);
		if (contract?.operations) {
			const contractRel = path.relative(root, specPath(root, fid, 'contracts', `${fid}.schema.json`));
			const contractSha = sha256File(specPath(root, fid, 'contracts', `${fid}.schema.json`));
			for (const [opId, op] of Object.entries(contract.operations)) {
				const nodeId = operationNodeId(fid, opId);
				addNode(nodeId, 'operation', opId, { feature_id: fid, attrs: { verb: op.verb ?? null, path: op.path ?? null } });
				addEdge(fid, nodeId, 'declares_operation', 'proven', { artifact: contractRel, artifact_sha256: contractSha, locator: `operations.${opId}` });
			}
		}

		// resources (+ their table mapping), from the disposed scan-report module
		for (const cls of ownClasses(root, fid)) {
			const nodeId = resourceNodeId(fid, cls.className);
			const rel = cls.file ? path.relative(root, cls.file) : null;
			addNode(nodeId, 'resource', cls.className, { feature_id: fid, file: rel, attrs: { table: cls.table ?? null, table_source: cls.tableSource ?? null } });
			const scanRel = path.relative(root, specPath(root, fid, 'brownfield-scan.json'));
			const scanSha = sha256File(specPath(root, fid, 'brownfield-scan.json'));
			addEdge(fid, nodeId, 'owns_resource', 'proven', { artifact: scanRel, artifact_sha256: scanSha, locator: `related_modules[].entities|dtos[className=${cls.className}]` });
			if (cls.table) {
				const tId = tableNodeId(cls.table);
				addNode(tId, 'table', cls.table.toLowerCase());
				const confidence = cls.tableSource === 'explicit' ? 'proven' : 'heuristic';
				addEdge(nodeId, tId, 'maps_to_table', confidence, { artifact: scanRel, artifact_sha256: scanSha, locator: `related_modules[].entities[className=${cls.className}].table` });
				resourceTableOf.set(nodeId, tId);
			}
		}

		// fields, and derives_from edges -- only fields a declared dependency already named
		const deps = loadFieldDependencies(root, fid);
		if (deps.dependencies.length > 0) {
			const depsRel = path.relative(root, specPath(root, fid, 'dependencies.json'));
			const depsSha = sha256File(specPath(root, fid, 'dependencies.json'));
			for (const dep of deps.dependencies) {
				const targetId = fieldNodeId(fid, dep.target.resourceType, dep.target.fieldName);
				const sourceId = fieldNodeId(dep.source.feature, dep.source.resourceType, dep.source.fieldName);
				addNode(targetId, 'field', `${dep.target.resourceType}.${dep.target.fieldName}`, { feature_id: fid });
				addNode(sourceId, 'field', `${dep.source.resourceType}.${dep.source.fieldName}`, { feature_id: dep.source.feature });
				addEdge(targetId, sourceId, 'derives_from', 'proven', { artifact: depsRel, artifact_sha256: depsSha, locator: `dependencies[target.fieldName=${dep.target.fieldName}]` });
			}
		}
	}

	// cross-feature findings: fk_references + name_collides_with (resource_type/operation_id only --
	// a `table` collision is already visible structurally, as two resources' maps_to_table edges
	// converging on the same shared table:: node, so a redundant collision edge is skipped there).
	for (const record of features) {
		const fid = record.feature_id;
		const report = loadCrossFeatureReport(root, fid);
		if (!report?.findings) continue;
		const reportRel = path.relative(root, specPath(root, fid, 'cross-feature-report.json'));
		const reportSha = sha256File(specPath(root, fid, 'cross-feature-report.json'));

		for (const finding of report.findings) {
			if (finding.signal === 'db_foreign_key') {
				const parsed = parseFkIdentifier(finding.identifier);
				if (!parsed) continue;
				const childId = tableNodeId(parsed.table);
				const parentId = tableNodeId(parsed.referencesTable);
				addNode(childId, 'table', parsed.table.toLowerCase());
				addNode(parentId, 'table', parsed.referencesTable.toLowerCase());
				addEdge(childId, parentId, 'fk_references', confidenceOf(finding), { artifact: reportRel, artifact_sha256: reportSha, locator: `findings[signal=db_foreign_key,identifier=${finding.identifier}]` });
			} else if (finding.signal === 'resource_type') {
				const ownId = resourceNodeId(fid, finding.identifier);
				const otherId = resourceNodeId(finding.other_feature, finding.identifier);
				if (nodes.has(ownId) && nodes.has(otherId)) {
					addEdge(ownId, otherId, 'name_collides_with', confidenceOf(finding), { artifact: reportRel, artifact_sha256: reportSha, locator: `findings[signal=resource_type,identifier=${finding.identifier}]` });
				}
			} else if (finding.signal === 'operation_id') {
				const ownId = operationNodeId(fid, finding.identifier);
				const otherId = operationNodeId(finding.other_feature, finding.identifier);
				if (nodes.has(ownId) && nodes.has(otherId)) {
					addEdge(ownId, otherId, 'name_collides_with', confidenceOf(finding), { artifact: reportRel, artifact_sha256: reportSha, locator: `findings[signal=operation_id,identifier=${finding.identifier}]` });
				}
			}
		}
	}

	return { schema: IMPACT_GRAPH_SCHEMA, generated_at: nowIso, nodes: [...nodes.values()], edges };
}

// D-cross-feature-impact-graph: one-hop reverse lookup -- every downstream feature whose
// dependencies.json names a (featureId, resourceType) pair on the SOURCE side, i.e. depends on it.
// Used by lib/impact.mjs's outbound-impact walk; kept here (not in lib/impact.mjs) since it is a
// pure graph query, not a check/accept/disposition operation.
export function downstreamFeaturesOf(graph, resourceOrOperationNodeId, relation) {
	const out = new Set();
	for (const edge of graph.edges) {
		if (edge.relation !== relation) continue;
		if (edge.target === resourceOrOperationNodeId) out.add({ featureNodeId: edge.source, edge });
	}
	return [...out];
}
