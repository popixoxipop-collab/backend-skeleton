import { analyzeJavaSyntax } from './java-syntax-facts.mjs';

const JAVA_LANG_ANNOTATIONS = new Set([
	'Deprecated', 'FunctionalInterface', 'Override', 'SafeVarargs', 'SuppressWarnings',
]);

function simpleName(fqn) {
	const i = fqn.lastIndexOf('.');
	return i === -1 ? fqn : fqn.slice(i + 1);
}

function stableUnique(values) {
	return [...new Set(values)].sort();
}

function requireSourceFile(file, index) {
	if (file === null || typeof file !== 'object' || Array.isArray(file)) {
		throw new TypeError(`files[${index}] must be an object`);
	}
	if (typeof file.path !== 'string' || file.path.length === 0) {
		throw new TypeError(`files[${index}].path must be non-empty`);
	}
	if (typeof file.source !== 'string') {
		throw new TypeError(`files[${index}].source must be a string`);
	}
}

// Project-local static symbol table. No target import, compilation, evaluation or build execution.
// Duplicate FQNs are retained as conflicts instead of using last-write-wins.
export function buildJvmProjectIndex(files) {
	if (!Array.isArray(files) || files.length === 0) {
		throw new TypeError('files must be a non-empty array');
	}
	const fileFacts = [];
	const typesByFqn = new Map();
	const diagnostics = [];

	for (let i = 0; i < files.length; i++) {
		requireSourceFile(files[i], i);
		const facts = analyzeJavaSyntax(files[i].source, { path: files[i].path });
		fileFacts.push(facts);
		for (const type of facts.topLevelTypes) {
			const fqn = facts.packageName ? `${facts.packageName}.${type.name}` : type.name;
			const symbol = { fqn, packageName: facts.packageName ?? '', path: facts.path, type };
			const prior = typesByFqn.get(fqn);
			if (!prior) {
				typesByFqn.set(fqn, symbol);
				continue;
			}
			const conflicts = Array.isArray(prior) ? prior : [prior];
			conflicts.push(symbol);
			typesByFqn.set(fqn, conflicts);
			diagnostics.push({
				code: 'JVM_DUPLICATE_TOP_LEVEL_TYPE',
				fqn,
				paths: stableUnique(conflicts.map((item) => item.path)),
			});
		}
	}
	return { fileFacts, typesByFqn, diagnostics };
}

function explicitImportCandidates(facts, name) {
	return stableUnique(facts.imports
		.filter((item) => !item.static && !item.wildcard && simpleName(item.name) === name)
		.map((item) => item.name));
}

function localProjectCandidate(index, facts, name) {
	const fqn = facts.packageName ? `${facts.packageName}.${name}` : name;
	const symbol = index.typesByFqn.get(fqn);
	return symbol && !Array.isArray(symbol) ? fqn : null;
}

function wildcardProjectCandidates(index, facts, name) {
	const out = [];
	for (const item of facts.imports) {
		if (item.static || !item.wildcard) continue;
		const prefix = item.name.slice(0, -2);
		const fqn = `${prefix}.${name}`;
		const symbol = index.typesByFqn.get(fqn);
		if (symbol && !Array.isArray(symbol)) out.push(fqn);
	}
	return stableUnique(out);
}

// Conservative annotation-name resolution. It resolves only facts proven by source/imports.
// Unknown external wildcard imports remain unknown rather than being guessed.
export function resolveJvmAnnotationName(index, facts, writtenName) {
	if (typeof writtenName !== 'string' || writtenName.length === 0) {
		throw new TypeError('writtenName must be non-empty');
	}
	if (writtenName.includes('.')) {
		return {
			status: 'resolved',
			fqn: writtenName,
			basis: 'written-qualified',
			candidates: [writtenName],
		};
	}

	const explicit = explicitImportCandidates(facts, writtenName);
	const local = localProjectCandidate(index, facts, writtenName);
	const wildcard = wildcardProjectCandidates(index, facts, writtenName);
	const proven = stableUnique([...explicit, ...(local ? [local] : []), ...wildcard]);

	if (proven.length === 1) {
		const fqn = proven[0];
		const basis = explicit.includes(fqn)
			? 'explicit-import'
			: local === fqn
				? 'same-package-project-type'
				: 'wildcard-project-type';
		return { status: 'resolved', fqn, basis, candidates: proven };
	}
	if (proven.length > 1) {
		return {
			status: 'conflict',
			fqn: null,
			basis: 'multiple-proven-candidates',
			candidates: proven,
		};
	}

	if (JAVA_LANG_ANNOTATIONS.has(writtenName)) {
		const fqn = `java.lang.${writtenName}`;
		return { status: 'resolved', fqn, basis: 'java-lang', candidates: [fqn] };
	}
	return {
		status: 'unknown',
		fqn: null,
		basis: 'insufficient-static-evidence',
		candidates: [],
	};
}

// Annotation graph only: no Spring route, HTTP method, JPA or authorization interpretation.
export function buildJvmAnnotationGraph(files, { maxDepth = 8 } = {}) {
	if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) {
		throw new RangeError('maxDepth must be an integer from 1 to 64');
	}
	const index = buildJvmProjectIndex(files);
	const factsByPath = new Map(index.fileFacts.map((facts) => [facts.path, facts]));
	const nodes = new Map();
	const diagnostics = [...index.diagnostics];

	for (const [fqn, symbolValue] of index.typesByFqn) {
		if (Array.isArray(symbolValue) || symbolValue.type.kind !== 'annotation') continue;
		const facts = factsByPath.get(symbolValue.path);
		const metaAnnotations = symbolValue.type.annotations.map((annotation) => ({
			writtenName: annotation.name,
			argsText: annotation.argsText,
			byteSpan: annotation.byteSpan,
			resolution: resolveJvmAnnotationName(index, facts, annotation.name),
		}));
		nodes.set(fqn, {
			fqn,
			path: symbolValue.path,
			byteSpan: symbolValue.type.byteSpan,
			metaAnnotations,
		});
	}

	function expand(startFqn) {
		if (!nodes.has(startFqn)) {
			return { status: 'unknown', startFqn, edges: [], cycles: [], truncated: false };
		}
		const edges = [];
		const cycles = [];
		const queue = [{ fqn: startFqn, depth: 0, stack: [startFqn] }];
		let truncated = false;

		while (queue.length) {
			const current = queue.shift();
			const node = nodes.get(current.fqn);
			if (!node) continue;
			if (current.depth >= maxDepth) {
				if (node.metaAnnotations.some(
					(annotation) => annotation.resolution.status === 'resolved'
						&& nodes.has(annotation.resolution.fqn),
				)) truncated = true;
				continue;
			}

			for (const annotation of node.metaAnnotations) {
				const to = annotation.resolution.fqn;
				edges.push({
					from: current.fqn,
					writtenName: annotation.writtenName,
					to,
					resolution: annotation.resolution.status,
					depth: current.depth + 1,
				});
				if (!to || !nodes.has(to)) continue;
				const cycleAt = current.stack.indexOf(to);
				if (cycleAt !== -1) {
					cycles.push([...current.stack.slice(cycleAt), to]);
					continue;
				}
				queue.push({
					fqn: to,
					depth: current.depth + 1,
					stack: [...current.stack, to],
				});
			}
		}

		return {
			status: cycles.length ? 'cycle' : truncated ? 'partial' : 'resolved',
			startFqn,
			edges,
			cycles,
			truncated,
		};
	}

	return { index, nodes, diagnostics, expand };
}
