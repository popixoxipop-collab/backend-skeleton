import { indexEntryMap } from './file-index.mjs';

function sameEntry(a, b) {
	return a && b && a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode;
}

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function sorted(set) {
	return [...set].sort(compareText);
}

// Edge shape: { dependent, dependency }. If `dependency` changes, `dependent` must be
// invalidated too. The graph is intentionally about files/artifacts, not JavaScript import syntax;
// language adapters can populate these edges from their own resolver without the scheduler
// guessing semantics.
export function computeInvalidation({ previousIndex, nextIndex, dependencyEdges = [], globalInputsChanged = false }) {
	const previous = indexEntryMap(previousIndex);
	const next = indexEntryMap(nextIndex);
	const added = new Set();
	const deleted = new Set();
	const modified = new Set();

	for (const [file, now] of next) {
		const before = previous.get(file);
		if (!before) added.add(file);
		else if (!sameEntry(before, now)) modified.add(file);
	}
	for (const file of previous.keys()) if (!next.has(file)) deleted.add(file);

	const changed = new Set([...added, ...deleted, ...modified]);
	const allPaths = new Set([...previous.keys(), ...next.keys()]);
	if (globalInputsChanged) for (const file of allPaths) changed.add(file);

	const dependentsByDependency = new Map();
	for (const edge of dependencyEdges) {
		if (!edge || typeof edge.dependent !== 'string' || typeof edge.dependency !== 'string') {
			throw new TypeError('dependencyEdges entries must be { dependent, dependency } strings');
		}
		if (!dependentsByDependency.has(edge.dependency)) dependentsByDependency.set(edge.dependency, new Set());
		dependentsByDependency.get(edge.dependency).add(edge.dependent);
	}

	const invalidated = new Set(changed);
	const queue = sorted(changed);
	for (let i = 0; i < queue.length; i++) {
		const current = queue[i];
		for (const dependent of dependentsByDependency.get(current) ?? []) {
			if (invalidated.has(dependent)) continue;
			invalidated.add(dependent);
			queue.push(dependent);
		}
	}

	return {
		schema: 'sbf.scan-invalidation/1',
		added: sorted(added),
		deleted: sorted(deleted),
		modified: sorted(modified),
		changed: sorted(changed),
		invalidated: sorted(invalidated),
		global_inputs_changed: Boolean(globalInputsChanged),
	};
}
