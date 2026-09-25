import { digestJson } from './cache-key.mjs';

export const T21_PROJECT_GRAPH_DRAFT = 'sbf.project-graph/draft-1';
export const T21_PROJECT_CACHE_PLAN_DRAFT = 'sbf.project-cache-plan/draft-1';

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function validateGraph(graph) {
	if (!graph || graph.schema !== T21_PROJECT_GRAPH_DRAFT || !Array.isArray(graph.projects) || !Array.isArray(graph.project_edges ?? [])) {
		throw new TypeError('expected sbf.project-graph/draft-1');
	}
	const ids = new Set();
	for (const project of graph.projects) {
		if (!project || typeof project.project_id !== 'string' || typeof project.root !== 'string') throw new TypeError('project graph contains an invalid project');
		if (ids.has(project.project_id)) throw new Error(`duplicate project_id: ${project.project_id}`);
		ids.add(project.project_id);
	}
	for (const edge of graph.project_edges ?? []) {
		if (!edge || typeof edge.kind !== 'string' || typeof edge.from_project_id !== 'string' || typeof edge.to_project_id !== 'string') {
			throw new TypeError('project graph contains an invalid edge');
		}
		if (!ids.has(edge.from_project_id) || !ids.has(edge.to_project_id)) throw new Error(`project edge references an unknown project: ${edge.from_project_id} -> ${edge.to_project_id}`);
	}
	return ids;
}

function selectedAdapter(project, includeFallback) {
	const selected = project.facets?.http?.selected_adapter ?? null;
	if (selected) return { adapter_id: selected, mode: 'first-class' };
	if (includeFallback && project.kind !== 'aggregate' && project.fallback_adapter) {
		return { adapter_id: project.fallback_adapter, mode: 'fallback' };
	}
	return null;
}

function localDependencies(graph, projectId) {
	return (graph.project_edges ?? [])
		.filter((edge) => edge.kind === 'local-package-dependency' && edge.from_project_id === projectId)
		.map((edge) => edge.to_project_id)
		.sort(compareText);
}

// Consumes T02's draft document shape as plain data. T21 deliberately does not import T02 code,
// so each workstream can evolve independently until the shared interface is frozen.
export function buildProjectCachePlan(graph, { includeFallback = false } = {}) {
	validateGraph(graph);
	const projects = [];
	for (const project of graph.projects) {
		const selection = selectedAdapter(project, includeFallback);
		if (!selection) continue;
		const markers = (project.markers ?? []).map((marker) => ({
			path: marker.path,
			kind: marker.kind ?? null,
			digest: marker.digest,
		})).sort((a, b) => compareText(`${a.path}\0${a.kind ?? ''}`, `${b.path}\0${b.kind ?? ''}`));
		const dependencyProjectIds = localDependencies(graph, project.project_id);
		const namespaceMaterial = {
			graph_schema: graph.schema,
			project_id: project.project_id,
			project_root: project.root,
			adapter_id: selection.adapter_id,
			mode: selection.mode,
			markers,
			dependency_project_ids: dependencyProjectIds,
		};
		projects.push({
			project_id: project.project_id,
			project_root: project.root,
			adapter_id: selection.adapter_id,
			mode: selection.mode,
			dependency_project_ids: dependencyProjectIds,
			cache_namespace: digestJson(namespaceMaterial),
			markers,
		});
	}
	projects.sort((a, b) => compareText(a.project_root, b.project_root) || compareText(a.adapter_id, b.adapter_id));
	return {
		schema: T21_PROJECT_CACHE_PLAN_DRAFT,
		graph_schema: graph.schema,
		projects,
	};
}

// T02 local-package-dependency edges point consumer -> dependency. If a dependency changes, every
// transitive consumer must invalidate too. Containment edges are intentionally ignored here:
// parent/aggregate discovery is not equivalent to a build/runtime dependency.
export function propagateProjectInvalidation(graph, changedProjectIds) {
	const ids = validateGraph(graph);
	if (!Array.isArray(changedProjectIds) || changedProjectIds.some((id) => typeof id !== 'string')) {
		throw new TypeError('changedProjectIds must be a string array');
	}
	for (const id of changedProjectIds) if (!ids.has(id)) throw new Error(`unknown changed project: ${id}`);
	const dependents = new Map();
	for (const edge of graph.project_edges ?? []) {
		if (edge.kind !== 'local-package-dependency') continue;
		if (!dependents.has(edge.to_project_id)) dependents.set(edge.to_project_id, new Set());
		dependents.get(edge.to_project_id).add(edge.from_project_id);
	}
	const invalidated = new Set(changedProjectIds);
	const queue = [...invalidated].sort(compareText);
	for (let i = 0; i < queue.length; i++) {
		for (const dependent of dependents.get(queue[i]) ?? []) {
			if (invalidated.has(dependent)) continue;
			invalidated.add(dependent);
			queue.push(dependent);
		}
	}
	return [...invalidated].sort(compareText);
}
