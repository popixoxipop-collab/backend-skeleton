import { scanJavaSpring } from './adapters/java-spring.mjs';
import { scanGenericGrep } from './adapters/generic-grep.mjs';

// D3 (see DECISIONS.md): verdict drives a disposition state machine, not an agent question.
// A module scores >= COLLISION_THRESHOLD only when it's a strong, multi-signal match (module
// name + controller/table/path/operationId overlap) -- e.g. scanning Team-IZ-Backend for
// "organization" scores the `organization` module's module-name match (10) alone at the
// threshold, before even counting its controller/table/path hits.
const COLLISION_THRESHOLD = 10;

function normalize(s) {
	return (s || '').toLowerCase();
}

function matches(text, terms) {
	const t = normalize(text);
	if (!t) return false;
	return terms.some((term) => {
		const nt = normalize(term);
		return nt && (t.includes(nt) || nt.includes(t));
	});
}

function scoreModule(mod, terms) {
	let score = 0;
	if (matches(mod.module, terms)) score += 10;
	for (const c of mod.controllers) {
		if (matches(c.className, terms)) score += 6;
		if (matches(c.basePath, terms)) score += 5;
		for (const ep of c.endpoints) {
			if (matches(ep.path, terms)) score += 5;
			if (matches(ep.operationId, terms)) score += 5;
		}
	}
	for (const e of mod.entities) {
		if (matches(e.table, terms)) score += 8;
		if (matches(e.className, terms)) score += 6;
	}
	for (const en of mod.enums) {
		if (matches(en.name, terms)) score += 3;
	}
	return score;
}

export function runScan({ repoRoot, terms, includeDb = false }) {
	const javaResult = scanJavaSpring(repoRoot);
	let adapter;
	let modules;
	let confidence;

	if (javaResult) {
		adapter = 'java-spring';
		modules = javaResult.modules;
		confidence = 'high';
	} else {
		const generic = scanGenericGrep(repoRoot);
		adapter = 'generic-grep';
		modules = generic.modules;
		confidence = 'low';
	}

	const scored = modules
		.map((m) => ({ ...m, score: scoreModule(m, terms) }))
		.sort((a, b) => b.score - a.score);

	const relatedModules = scored.filter((m) => m.score > 0);
	const collisions = relatedModules.filter((m) => m.score >= COLLISION_THRESHOLD);

	let verdict = 'greenfield';
	if (collisions.length > 0) verdict = 'collision';
	else if (relatedModules.length > 0) verdict = 'adjacent';

	const unknowns = [];
	if (!includeDb) {
		unknowns.push('DB not scanned (Plane C is opt-in via --db, off by default -- see D-db in DECISIONS.md)');
	}

	return {
		schema: 'sbf.scan-report/1',
		terms,
		adapter,
		confidence,
		api_surface_source: 'source-annotations (no committed openapi spec found)',
		verdict,
		related_modules: relatedModules,
		collisions,
		unknowns,
	};
}
