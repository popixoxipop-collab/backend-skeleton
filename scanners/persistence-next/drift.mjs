import { assertPersistenceIr } from './ir.mjs';

function physicalKey(entity, { defaultSchema = null } = {}) {
	if (!entity.table?.name) return null;
	return `${entity.table.schema ?? defaultSchema ?? ''}\u0000${entity.table.name}`;
}

function entityByPhysicalTable(ir, opts = {}) {
	const out = new Map();
	for (const entity of ir.entities) {
		const key = physicalKey(entity, opts);
		if (!key) continue;
		if (!out.has(key)) out.set(key, []);
		out.get(key).push(entity);
	}
	return out;
}

function confidenceForTable(entity) {
	return entity.table.source === 'explicit' || entity.table.source === 'observed' ? 'high' : 'medium';
}

function sameSet(a, b) {
	if (a.length !== b.length) return false;
	const bs = new Set(b);
	return a.every((x) => bs.has(x));
}

export function comparePersistenceIr({ expected, observed, default_schema = null }) {
	const left = assertPersistenceIr(expected);
	const right = assertPersistenceIr(observed);
	const rightByTable = entityByPhysicalTable(right, { defaultSchema: default_schema });
	const findings = [];
	const unknowns = [];
	for (const entity of left.entities) {
		const key = physicalKey(entity, { defaultSchema: default_schema });
		if (!key) {
			unknowns.push({ entity_id: entity.id, code: 'expected-table-unknown', message: `${entity.name}: physical table name is unknown` });
			continue;
		}
		const matches = rightByTable.get(key) ?? [];
		if (matches.length === 0) {
			findings.push({ entity_id: entity.id, code: 'table-missing', table: entity.table.name, confidence: confidenceForTable(entity) });
			continue;
		}
		if (matches.length > 1) {
			unknowns.push({ entity_id: entity.id, code: 'observed-table-ambiguous', message: `${entity.table.name}: ${matches.length} observed entities share this physical table identity` });
			continue;
		}
		const actual = matches[0];
		const actualFields = new Set(actual.fields.map((f) => f.name));
		for (const field of entity.fields) {
			if (!actualFields.has(field.name)) findings.push({
				entity_id: entity.id, code: 'column-missing', table: entity.table.name, column: field.name,
				confidence: field.source === 'source' || field.source === 'migration' ? confidenceForTable(entity) : 'medium',
			});
		}
		const expectedPk = entity.primary_key.columns;
		const observedPk = actual.primary_key.columns;
		if (expectedPk.length > 0 && observedPk.length > 0 && !sameSet(expectedPk, observedPk)) findings.push({
			entity_id: entity.id, code: 'primary-key-mismatch', table: entity.table.name,
			expected: expectedPk, observed: observedPk, confidence: confidenceForTable(entity),
		});
		if (expectedPk.length > 0 && observedPk.length === 0) unknowns.push({
			entity_id: entity.id, code: 'observed-primary-key-unknown', message: `${entity.table.name}: expected primary key is known but observed plane has no PK fact`,
		});
	}
	return {
		findings: findings.sort((a, b) => (a.table ?? '').localeCompare(b.table ?? '') || a.code.localeCompare(b.code) || (a.column ?? '').localeCompare(b.column ?? '')),
		unknowns: unknowns.sort((a, b) => a.entity_id.localeCompare(b.entity_id) || a.code.localeCompare(b.code)),
	};
}

export function compareSourceMigrationLive({ source = null, migrations = null, live = null, default_schema = null }) {
	const comparisons = [];
	if (source && migrations) comparisons.push({ name: 'source-vs-migrations', ...comparePersistenceIr({ expected: source, observed: migrations, default_schema }) });
	if (source && live) comparisons.push({ name: 'source-vs-live', ...comparePersistenceIr({ expected: source, observed: live, default_schema }) });
	if (migrations && live) comparisons.push({ name: 'migrations-vs-live', ...comparePersistenceIr({ expected: migrations, observed: live, default_schema }) });
	return { comparisons };
}
