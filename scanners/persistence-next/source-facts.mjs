import { createPersistenceIr, makeSourceRef } from './ir.mjs';

export const PERSISTENCE_SOURCE_FACTS_CONTRACT = 'bskel.internal.persistence-source-facts/0';

const BASIS = new Set(['explicit', 'default', 'unknown']);
const PAIRING = new Set(['resolved', 'unknown']);

function nonEmpty(value, label) {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function nullableString(value, label) {
	if (value == null) return null;
	return nonEmpty(value, label);
}

function strings(values, label) {
	if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
	return values.map((value, index) => nonEmpty(value, `${label}[${index}]`));
}

function basis(value, label) {
	if (!BASIS.has(value)) throw new TypeError(`${label} must be explicit, default, or unknown`);
	return value;
}

function tableSource(value) {
	if (value === 'explicit') return 'explicit';
	if (value === 'default') return 'inferred';
	return 'unknown';
}

function validateSource(source, label) {
	if (!source || typeof source !== 'object') throw new TypeError(`${label}.source is required`);
	return {
		file: nonEmpty(source.file, `${label}.source.file`),
		line: source.line == null ? null : source.line,
		detail: source.detail == null ? null : String(source.detail),
	};
}

function validateEntity(entity, index) {
	const label = `entities[${index}]`;
	if (!entity || typeof entity !== 'object') throw new TypeError(`${label} must be an object`);
	const name = nonEmpty(entity.name, `${label}.name`);
	const source = validateSource(entity.source, label);
	const tableBasis = basis(entity.table?.basis ?? 'unknown', `${label}.table.basis`);
	const tableName = nullableString(entity.table?.name ?? null, `${label}.table.name`);
	if (tableBasis === 'unknown' && tableName !== null) throw new TypeError(`${label}.table cannot carry a name with unknown basis`);
	if (tableBasis !== 'unknown' && tableName === null) throw new TypeError(`${label}.table needs a name when basis is known`);

	const pkBasis = basis(entity.primary_key?.basis ?? 'unknown', `${label}.primary_key.basis`);
	const pkColumns = strings(entity.primary_key?.columns ?? [], `${label}.primary_key.columns`);
	if (pkBasis === 'unknown' && pkColumns.length > 0) throw new TypeError(`${label}.primary_key cannot carry columns with unknown basis`);
	if (pkBasis !== 'unknown' && pkColumns.length === 0) throw new TypeError(`${label}.primary_key needs columns when basis is known`);

	const fields = (entity.fields ?? []).map((field, fieldIndex) => {
		if (!field || typeof field !== 'object') throw new TypeError(`${label}.fields[${fieldIndex}] must be an object`);
		const fieldBasis = basis(field.basis ?? 'unknown', `${label}.fields[${fieldIndex}].basis`);
		if (fieldBasis === 'unknown') throw new TypeError(`${label}.fields[${fieldIndex}] must not emit an unknown physical field`);
		return {
			name: nonEmpty(field.name, `${label}.fields[${fieldIndex}].name`),
			type: field.type == null ? null : String(field.type),
			nullable: typeof field.nullable === 'boolean' ? field.nullable : null,
			basis: fieldBasis,
		};
	});

	const relations = (entity.relations ?? []).map((relation, relationIndex) => {
		if (!relation || typeof relation !== 'object') throw new TypeError(`${label}.relations[${relationIndex}] must be an object`);
		const pairing = relation.pairing ?? 'unknown';
		if (!PAIRING.has(pairing)) throw new TypeError(`${label}.relations[${relationIndex}].pairing must be resolved or unknown`);
		const columns = strings(relation.columns ?? [], `${label}.relations[${relationIndex}].columns`);
		const targetColumns = strings(relation.references_columns ?? [], `${label}.relations[${relationIndex}].references_columns`);
		const targetTable = nullableString(relation.references_table ?? null, `${label}.relations[${relationIndex}].references_table`);
		if (pairing === 'resolved' && (columns.length === 0 || columns.length !== targetColumns.length || !targetTable)) {
			throw new TypeError(`${label}.relations[${relationIndex}] resolved pairing requires equal non-empty columns and a target table`);
		}
		return {
			columns,
			references_table: targetTable,
			references_schema: nullableString(relation.references_schema ?? null, `${label}.relations[${relationIndex}].references_schema`),
			references_columns: targetColumns,
			pairing,
		};
	});

	return {
		id: entity.id == null ? null : nonEmpty(entity.id, `${label}.id`),
		name,
		module: nullableString(entity.module ?? null, `${label}.module`),
		source,
		table: { name: tableName, schema: nullableString(entity.table?.schema ?? null, `${label}.table.schema`), basis: tableBasis },
		primary_key: { columns: pkColumns, type: entity.primary_key?.type == null ? 'unknown' : String(entity.primary_key.type), basis: pkBasis },
		fields,
		relations,
	};
}

export function validatePersistenceSourceFacts(facts) {
	if (!facts || typeof facts !== 'object') throw new TypeError('persistence source facts must be an object');
	if (facts.contract !== PERSISTENCE_SOURCE_FACTS_CONTRACT) throw new TypeError(`expected ${PERSISTENCE_SOURCE_FACTS_CONTRACT}`);
	const producerId = nonEmpty(facts.producer_id, 'producer_id');
	const persistenceId = nonEmpty(facts.persistence_id, 'persistence_id');
	const language = nonEmpty(facts.language, 'language');
	if (typeof facts.complete !== 'boolean') throw new TypeError('complete must be boolean');
	if (!Array.isArray(facts.entities) || !Array.isArray(facts.unknowns)) throw new TypeError('entities[] and unknowns[] are required');
	const entities = facts.entities.map(validateEntity);
	const ids = new Set();
	for (const entity of entities) {
		if (!entity.id) continue;
		if (ids.has(entity.id)) throw new TypeError(`duplicate persistence source entity id: ${entity.id}`);
		ids.add(entity.id);
	}
	return {
		contract: PERSISTENCE_SOURCE_FACTS_CONTRACT,
		producer_id: producerId,
		persistence_id: persistenceId,
		language,
		complete: facts.complete,
		entities,
		unknowns: facts.unknowns,
	};
}

export function fromPersistenceSourceFacts(input) {
	const facts = validatePersistenceSourceFacts(input);
	const diagnostics = facts.unknowns.map((unknown) => ({
		code: 'upstream-persistence-unknown',
		level: 'info',
		producer: facts.producer_id,
		source_code: unknown?.code ?? null,
		entity: unknown?.entity ?? null,
		message: unknown?.message ?? unknown?.reason ?? 'upstream persistence fact remains unknown',
	}));
	if (facts.complete !== true) diagnostics.push({
		code: 'upstream-persistence-facts-incomplete',
		level: 'warning',
		producer: facts.producer_id,
		message: 'upstream analysis reports complete=false; emitted facts are preserved but cannot imply full persistence coverage',
	});

	const entities = facts.entities.map((entity) => ({
		...(entity.id ? { id: entity.id } : {}),
		provider: facts.persistence_id,
		name: entity.name,
		module: entity.module,
		file: entity.source.file,
		table: {
			name: entity.table.name,
			schema: entity.table.schema,
			source: tableSource(entity.table.basis),
		},
		primary_key: {
			columns: entity.primary_key.columns,
			type: entity.primary_key.type,
			source: entity.primary_key.basis === 'unknown' ? 'unknown' : 'source',
		},
		fields: entity.fields.map((field) => ({
			name: field.name,
			type: field.type,
			nullable: field.nullable,
			source: field.basis === 'explicit' ? 'source' : 'source-default',
		})),
		relations: entity.relations
			.filter((relation) => relation.references_table)
			.map((relation) => ({
				columns: relation.columns,
				references_table: relation.references_table,
				references_schema: relation.references_schema,
				references_columns: relation.references_columns,
				pairing: relation.pairing,
				source: 'source',
			})),
		source_refs: [makeSourceRef({
			kind: 'source',
			provider: facts.persistence_id,
			file: entity.source.file,
			line: entity.source.line,
			detail: entity.source.detail ?? `${facts.producer_id} persistence facts`,
		})],
	}));

	return createPersistenceIr({
		provider: facts.persistence_id,
		source_kind: 'source',
		entities,
		diagnostics,
		metadata: {
			upstream_contract: PERSISTENCE_SOURCE_FACTS_CONTRACT,
			producer_id: facts.producer_id,
			language: facts.language,
			upstream_complete: facts.complete,
		},
	});
}
