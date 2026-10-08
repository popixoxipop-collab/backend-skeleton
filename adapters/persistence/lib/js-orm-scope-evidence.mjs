// Computes the machine-derived parts of an ORM scope record (fixture hashes, expected oracle facts,
// provider output, provider-vs-oracle agreement, migration-plane probe results) from the committed files
// and the repository's own sources. The refresh tool writes them; the audit recomputes and compares.
import fs from 'node:fs';
import path from 'node:path';
import { compareFacts, compareSet, diffColumnFacts, oracleStepFacts, sha256Lf } from './js-orm-scope-facts.mjs';
import { PERSISTENCE_DIR, recomputeProvider, runMigrationProbe } from './js-orm-scope-providers.mjs';

export function diskIo(orm) {
	const dir = path.join(PERSISTENCE_DIR, orm);
	return {
		dir,
		readText: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'),
		exists: (rel) => fs.existsSync(path.join(dir, rel)),
		listFiles: (rel) => listFiles(path.join(dir, rel)).map((file) => path.relative(dir, file).split(path.sep).join('/')),
	};
}

function listFiles(root) {
	if (!fs.existsSync(root)) return [];
	const out = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) out.push(...listFiles(full));
		else out.push(full);
	}
	return out.sort();
}

export function formatScope(scope) {
	return `${JSON.stringify(scope, null, '\t')}\n`;
}

export function stepById(scope, id) {
	return scope.oracle.steps.find((step) => step.id === id);
}

export function expectedChanges(scope, scopeCase, expected) {
	const diff = scopeCase.oracle_steps.find((id) => stepById(scope, id)?.role === 'migration-diff');
	if (diff) return expected[diff].changes;
	const schemas = scopeCase.oracle_steps.filter((id) => stepById(scope, id)?.role === 'expected-schema');
	if (schemas.length === 2) {
		const [from, to] = schemas.map((id) => expected[id]);
		return diffColumnFacts(from.columns, to.columns, from.tables, to.tables);
	}
	return null;
}

export function caseOutcome(provider, agreement) {
	if (provider.mode === 'absent') return 'not-applicable';
	if (provider.detected === false) return 'not-detected';
	const results = Object.values(agreement).map((entry) => entry.result);
	if (results.some((result) => result === 'mismatch' || result === 'provider-extra')) return 'diverges';
	if (results.some((result) => result === 'provider-omits')) return 'omits';
	return 'agrees';
}

export function computeCaseEvidence(orm, scope, scopeCase, io = diskIo(orm)) {
	const fixtureFiles = scopeCase.fixture.files.map((file) => ({ path: file.path, sha256: sha256Lf(io.readText(file.path)) }));
	const expected = {};
	for (const id of scopeCase.oracle_steps) {
		const step = stepById(scope, id);
		expected[id] = oracleStepFacts(orm, step, io.readText(step.result_file));
	}
	const isDrift = scopeCase.category === 'migration-drift';
	const changes = isDrift ? expectedChanges(scope, scopeCase, expected) : null;
	const provider = recomputeProvider(orm, scope, scopeCase);
	let agreement = null;
	if (provider.mode !== 'absent') {
		agreement = isDrift
			? { changes: compareSet(changes ?? [], provider.changes?.changes ?? []) }
			: compareFacts(expected[scopeCase.oracle_steps[0]], provider.facts ?? {});
	}
	return { fixture_files: fixtureFiles, expected, expected_changes: changes, provider, agreement, outcome: caseOutcome(provider, agreement) };
}

export function computeProbeEvidence(orm, probe) {
	return runMigrationProbe(orm, probe);
}

export function computeEvidence(orm, scope, io = diskIo(orm)) {
	const cases = {};
	for (const scopeCase of scope.cases) cases[scopeCase.id] = computeCaseEvidence(orm, scope, scopeCase, io);
	return { cases, migration_plane: computeProbeEvidence(orm, scope.probes.migration_plane) };
}

// Rebuilds the machine-derived fields in a fixed key order so the file is canonical.
export function applyEvidence(scope, evidence) {
	scope.cases = scope.cases.map((scopeCase) => {
		const item = evidence.cases[scopeCase.id];
		const rebuilt = {
			id: scopeCase.id,
			category: scopeCase.category,
			kind: scopeCase.kind,
			purpose: scopeCase.purpose,
			fixture: { files: item.fixture_files },
			oracle_steps: scopeCase.oracle_steps,
			expected: item.expected,
		};
		if (item.expected_changes) rebuilt.expected_changes = item.expected_changes;
		rebuilt.provider = item.provider;
		rebuilt.agreement = item.agreement;
		rebuilt.outcome = item.outcome;
		return rebuilt;
	});
	const plane = scope.probes.migration_plane;
	scope.probes.migration_plane = {
		basis: plane.basis,
		claim: plane.claim,
		layout: plane.layout,
		control: plane.control,
		observed: evidence.migration_plane.observed,
		control_observed: evidence.migration_plane.control_observed,
	};
	return scope;
}
